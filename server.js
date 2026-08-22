const express = require('express');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const db = new sqlite3.Database('./database.sqlite');

app.use(bodyParser.json());

// --- CONFIGURATION DES SESSIONS ---
app.use(session({
    secret: 'votre_secret_tres_securise_et_aleatoire',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// --- MIDDLEWARE DE PROTECTION (CONNEXION OBLIGATOIRE) ---
app.use((req, res, next) => {
    const cheminsPublics = [
        '/', '/login.html', '/reset.html', 
        '/api/login', '/api/profils', '/api/mot-de-passe-oublie', '/api/reset-password'
    ];
    
    const estPublic = cheminsPublics.includes(req.path) || 
                      req.path.startsWith('/css/') || 
                      req.path.startsWith('/js/') || 
                      req.path.startsWith('/api/profils');
                      
    if (req.session.user || estPublic) {
        next();
    } else {
        if (req.path.endsWith('.html') || req.path === '/') {
            return res.redirect('/login.html');
        }
        res.status(401).json({ error: "Accès non autorisé. Veuillez vous connecter." });
    }
});

app.use(express.static('public'));

// --- CONFIGURATION EMAIL ---
const transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    auth: { user: 'votre_email@example.com', pass: 'votre_mot_de_passe_smtp' }
});

// --- INITIALISATION BDD ---
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS profils (nom TEXT PRIMARY KEY, email TEXT UNIQUE, mdp TEXT, reset_token TEXT, reset_expires INTEGER, calories REAL, budget REAL, proteines REAL, glucides REAL, lipides REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS recettes (id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT, categorie TEXT, parts INTEGER, ingredients TEXT, etapes TEXT, cout REAL, calories REAL, proteines REAL, glucides REAL, lipides REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT, rayon TEXT, calories REAL, proteines REAL, glucides REAL, lipides REAL, prix REAL, marques TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS menu_prevu (profil TEXT, jour TEXT, petitDejeuner TEXT, repas1 TEXT, repas2 TEXT, dessertCollation TEXT, PRIMARY KEY (profil, jour))`);
    db.run(`CREATE TABLE IF NOT EXISTS suivi_consomme (id INTEGER PRIMARY KEY AUTOINCREMENT, profil TEXT, jour TEXT, categorie TEXT, recette_id INTEGER, quantite REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS courses (id INTEGER PRIMARY KEY AUTOINCREMENT, profil TEXT, ingredient_id INTEGER, nom TEXT, rayon TEXT, quantite_necessaire REAL, unite TEXT, prix_total REAL, coche INTEGER DEFAULT 0)`);
});

// --- API AUTHENTIFICATION & PROFILS ---
app.post('/api/login', (req, res) => {
    const { email, mdp } = req.body;
    db.get("SELECT * FROM profils WHERE email = ?", [email], async (err, user) => {
        if (user && user.mdp && await bcrypt.compare(mdp, user.mdp)) {
            req.session.user = user.nom;
            res.json({ success: true, nom: user.nom });
        } else {
            res.status(401).json({ error: "E-mail ou mot de passe incorrect." });
        }
    });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

app.get('/api/profils', (req, res) => {
    db.all("SELECT nom, email, calories, budget, proteines, glucides, lipides FROM profils", [], (err, rows) => res.json(rows || []));
});

app.post('/api/profils', async (req, res) => {
    const { nom, email, mdp, calories, budget, proteines, glucides, lipides } = req.body;
    try {
        const hashedPassword = mdp ? await bcrypt.hash(mdp, 10) : null;
        db.run(`INSERT INTO profils (nom, email, mdp, calories, budget, proteines, glucides, lipides) VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(nom) DO UPDATE SET email=excluded.email, mdp=COALESCE(excluded.mdp, mdp), calories=excluded.calories, budget=excluded.budget`,
        [nom, email, hashedPassword, calories || 2000, budget || 50, proteines || 100, glucides || 250, lipides || 70], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            req.session.user = nom;
            io.emit('data_updated');
            res.json({ success: true });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API RECETTES ---
app.get('/api/recettes', (req, res) => {
    db.all("SELECT * FROM recettes", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/recettes', (req, res) => {
    const { nom, categorie, parts, ingredients, etapes, cout, calories, proteines, glucides, lipides } = req.body;
    let ingredientsToSave = Array.isArray(ingredients) ? JSON.stringify(ingredients) : (typeof ingredients === 'string' ? ingredients : JSON.stringify([]));

    db.run(`INSERT INTO recettes (nom, categorie, parts, ingredients, etapes, cout, calories, proteines, glucides, lipides) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [nom, categorie, parts, ingredientsToSave, etapes, cout, calories, proteines, glucides, lipides], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true, id: this.lastID });
    });
});

// --- API INGREDIENTS ---
app.get('/api/ingredients', (req, res) => {
    db.all("SELECT * FROM ingredients", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => ({ ...r, marques: r.marques ? JSON.parse(r.marques) : [] })));
    });
});

app.post('/api/ingredients', (req, res) => {
    const { nom, rayon, calories, proteines, glucides, lipides, prix, marques } = req.body;
    const marquesStr = Array.isArray(marques) ? JSON.stringify(marques) : (marques || '[]');
    
    db.run(`INSERT INTO ingredients (nom, rayon, calories, proteines, glucides, lipides, prix, marques) VALUES (?,?,?,?,?,?,?,?)`,
    [nom, rayon || 'Épicerie', calories || 0, proteines || 0, glucides || 0, lipides || 0, prix || 0, marquesStr], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true, id: this.lastID });
    });
});

// --- API MENU PRÉVU ---
app.get('/api/menu-prevu', (req, res) => {
    const { profil, jour } = req.query;
    if (jour && profil) {
        db.get("SELECT * FROM menu_prevu WHERE profil = ? AND jour = ?", [profil, jour], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(row || {});
        });
    } else if (profil) {
        db.all("SELECT * FROM menu_prevu WHERE profil = ?", [profil], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    } else {
        db.all("SELECT * FROM menu_prevu", [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    }
});

app.post('/api/menu-prevu', (req, res) => {
    const { jour, profil, petitDejeuner, repas1, repas2, dessertCollation } = req.body;
    const q = `INSERT INTO menu_prevu (profil, jour, petitDejeuner, repas1, repas2, dessertCollation) VALUES (?,?,?,?,?,?) 
               ON CONFLICT(profil, jour) DO UPDATE SET petitDejeuner=excluded.petitDejeuner, repas1=excluded.repas1, repas2=excluded.repas2, dessertCollation=excluded.dessertCollation`;
    db.run(q, [profil, jour, petitDejeuner, repas1, repas2, dessertCollation], (err) => {
        if (err) res.status(500).json({ error: err.message });
        else { io.emit('data_updated'); res.sendStatus(200); }
    });
});

// --- API COURSES (GÉNÉRATION, LISTE ET GESTION) ---
app.get('/api/courses', (req, res) => {
    const { profil } = req.query;
    const query = profil ? "SELECT * FROM courses WHERE profil = ?" : "SELECT * FROM courses";
    db.all(query, profil ? [profil] : [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post('/api/courses/cocher', (req, res) => {
    const { id, coche } = req.body;
    db.run("UPDATE courses SET coche = ? WHERE id = ?", [coche ? 1 : 0, id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});

app.post('/api/courses/generer', (req, res) => {
    const { profil } = req.body;
    db.all("SELECT * FROM menu_prevu WHERE profil = ?", [profil], (err, menus) => {
        let idsRecettes = new Set();
        menus.forEach(m => ['petitDejeuner', 'repas1', 'repas2', 'dessertCollation'].forEach(c => { if (m[c]) idsRecettes.add(m[c]); }));
        
        if (idsRecettes.size === 0) return res.json({ success: true });

        const placeholders = Array.from(idsRecettes).map(() => '?').join(',');
        db.all(`SELECT * FROM recettes WHERE id IN (${placeholders})`, Array.from(idsRecettes), (err, recettes) => {
            db.all("SELECT * FROM ingredients", [], (err, ingsRef) => {
                let besoins = {};
                recettes.forEach(r => {
                    try {
                        let ings = typeof r.ingredients === 'string' ? JSON.parse(r.ingredients) : r.ingredients;
                        if (Array.isArray(ings)) ings.forEach(i => {
                            let id = i.id || i.ingredient_id;
                            if (id) besoins[id] = (besoins[id] || 0) + parseFloat(i.quantite || 0);
                        });
                    } catch (e) {}
                });
                db.run("DELETE FROM courses WHERE profil = ?", [profil], () => {
                    const stmt = db.prepare("INSERT INTO courses (profil, ingredient_id, nom, rayon, quantite_necessaire, unite, prix_total, coche) VALUES (?,?,?,?,?,?,?,0)");
                    for (const [id, qte] of Object.entries(besoins)) {
                        const ref = ingsRef.find(i => i.id == id);
                        if (ref) stmt.run(profil, ref.id, ref.nom, ref.rayon || 'Épicerie', qte, 'g', 0);
                    }
                    stmt.finalize(() => { io.emit('data_updated'); res.json({ success: true }); });
                });
            });
        });
    });
});

// --- API FRIGO (RECETTES FAISABLES) ---
app.get('/api/frigo/recettes-faisables', (req, res) => {
    const { profil } = req.query;
    db.all("SELECT * FROM recettes", [], (err, recettes) => {
        db.all("SELECT ingredient_id FROM courses WHERE profil = ? AND coche = 1", [profil], (err, courses) => {
            const dispo = new Set(courses.map(c => c.ingredient_id));
            res.json(recettes.filter(r => {
                try {
                    let ings = typeof r.ingredients === 'string' ? JSON.parse(r.ingredients) : r.ingredients;
                    return Array.isArray(ings) && ings.every(i => dispo.has(Number(i.id || i.ingredient_id)));
                } catch { return false; }
            }));
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));