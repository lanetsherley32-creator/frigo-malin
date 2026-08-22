const express = require('express');
const http = require('http');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- CONNEXION POSTGRESQL (SUPABASE) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

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

// --- API AUTHENTIFICATION & PROFILS ---
app.post('/api/login', async (req, res) => {
    const { email, mdp } = req.body;
    try {
        const result = await pool.query("SELECT * FROM profils WHERE email = $1", [email]);
        const user = result.rows[0];
        if (user && user.mdp && await bcrypt.compare(mdp, user.mdp)) {
            req.session.user = user.nom;
            res.json({ success: true, nom: user.nom });
        } else {
            res.status(401).json({ error: "E-mail ou mot de passe incorrect." });
        }
    } catch (err) {
        console.error("ERREUR LOGIN:", err);
        res.status(500).json({ error: err.message, detail: err.stack });
    }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

app.get('/api/current-user', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Non connecté" });
    try {
        const result = await pool.query("SELECT nom, email FROM profils WHERE nom = $1", [req.session.user]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: "Profil introuvable" });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/profils', async (req, res) => {
    try {
        const result = await pool.query("SELECT nom, email FROM profils");
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/profils', async (req, res) => {
    const { nom, email, mdp } = req.body;
    try {
        const hashedPassword = mdp ? await bcrypt.hash(mdp, 10) : null;
        const query = `
            INSERT INTO profils (nom, email, mdp) 
            VALUES ($1, $2, $3)
            ON CONFLICT (nom) DO UPDATE SET 
                email = EXCLUDED.email, 
                mdp = COALESCE(EXCLUDED.mdp, profils.mdp)
        `;
        await pool.query(query, [nom, email, hashedPassword]);
        req.session.user = nom;
        io.emit('data_updated');
        res.json({ success: true });
    } catch (e) {
        console.error("ERREUR DÉTAILLÉE SIGNUP:", e);
        res.status(500).json({ error: e.message || "Erreur inconnue", detail: e.stack });
    }
});

// --- API MOT DE PASSE OUBLIÉ & RESET ---
app.post('/api/mot-de-passe-oublie', async (req, res) => {
    const { email } = req.body;
    try {
        const result = await pool.query("SELECT * FROM profils WHERE email = $1", [email]);
        const user = result.rows[0];
        if (!user) {
            return res.status(404).json({ error: "Aucun compte associé à cet e-mail." });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + 3600000; // Valide 1 heure

        await pool.query("UPDATE profils SET reset_token = $1, reset_expires = $2 WHERE email = $3", [token, expires, email]);

        const resetLink = `${req.protocol}://${req.get('host')}/reset.html?token=${token}`;
        
        try {
            await transporter.sendMail({
                from: '"Menu de la Semaine" <noreply@menudesemaine.com>',
                to: email,
                subject: 'Réinitialisation de votre mot de passe',
                text: `Bonjour, cliquez sur ce lien pour réinitialiser votre mot de passe : ${resetLink}`
            });
            res.json({ success: true, message: "E-mail de réinitialisation envoyé." });
        } catch (e) {
            res.json({ success: true, message: "Lien de réinitialisation généré (mode dev)", debug_link: resetLink });
        }
    } catch (err) {
        res.status(500).json({ error: "Erreur serveur." });
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, nouveauMdp } = req.body;
    try {
        const result = await pool.query("SELECT * FROM profils WHERE reset_token = $1 AND reset_expires > $2", [token, Date.now()]);
        const user = result.rows[0];
        if (!user) {
            return res.status(400).json({ error: "Token invalide ou expiré." });
        }

        const hashedPassword = await bcrypt.hash(nouveauMdp, 10);
        await pool.query("UPDATE profils SET mdp = $1, reset_token = NULL, reset_expires = NULL WHERE nom = $2", [hashedPassword, user.nom]);
        res.json({ success: true, message: "Mot de passe mis à jour avec succès." });
    } catch (e) {
        res.status(500).json({ error: "Erreur lors de la mise à jour." });
    }
});

// --- API RECETTES & INGREDIENTS (PARTAGÉS) ---
app.get('/api/recettes', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM recettes");
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/recettes', async (req, res) => {
    const { nom, categorie, parts, ingredients, etapes, cout, calories, proteines, glucides, lipides } = req.body;
    let ingredientsToSave = Array.isArray(ingredients) ? JSON.stringify(ingredients) : (typeof ingredients === 'string' ? ingredients : JSON.stringify([]));

    try {
        const query = `
            INSERT INTO recettes (nom, categorie, parts, ingredients, etapes, cout, calories, proteines, glucides, lipides) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
        `;
        const result = await pool.query(query, [nom, categorie, parts, ingredientsToSave, etapes, cout, calories, proteines, glucides, lipides]);
        io.emit('data_updated');
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/ingredients', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM ingredients");
        const rows = (result.rows || []).map(r => ({ ...r, marques: r.marques ? JSON.parse(r.marques) : [] }));
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ingredients', async (req, res) => {
    const { nom, rayon, calories, proteines, glucides, lipides, prix, marques } = req.body;
    const marquesStr = Array.isArray(marques) ? JSON.stringify(marques) : (marques || '[]');
    
    try {
        const query = `
            INSERT INTO ingredients (nom, rayon, calories, proteines, glucides, lipides, prix, marques) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
        `;
        const result = await pool.query(query, [nom, rayon || 'Épicerie', calories || 0, proteines || 0, glucides || 0, lipides || 0, prix || 0, marquesStr]);
        io.emit('data_updated');
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API MENU, COURSES & FRIGO (PRIVÉS) ---
app.get('/api/menu-prevu', async (req, res) => {
    const profil = req.session.user;
    if (!profil) return res.status(401).json({ error: "Non connecté" });
    try {
        const result = await pool.query("SELECT * FROM menu_prevu WHERE profil = $1", [profil]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/menu-prevu', async (req, res) => {
    const profil = req.session.user;
    if (!profil) return res.status(401).json({ error: "Non connecté" });

    const { jour, petitDejeuner, repas1, repas2, dessertCollation } = req.body;
    const q = `
        INSERT INTO menu_prevu (profil, jour, petitDejeuner, repas1, repas2, dessertCollation) 
        VALUES ($1, $2, $3, $4, $5, $6) 
        ON CONFLICT (profil, jour) DO UPDATE SET 
            petitDejeuner = EXCLUDED.petitDejeuner, 
            repas1 = EXCLUDED.repas1, 
            repas2 = EXCLUDED.repas2, 
            dessertCollation = EXCLUDED.dessertCollation
    `;
    try {
        await pool.query(q, [profil, jour, petitDejeuner, repas1, repas2, dessertCollation]);
        io.emit('data_updated');
        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/courses', async (req, res) => {
    const profil = req.session.user;
    if (!profil) return res.status(401).json({ error: "Non connecté" });
    try {
        const result = await pool.query("SELECT * FROM courses WHERE profil = $1", [profil]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/courses/cocher', async (req, res) => {
    const profil = req.session.user;
    if (!profil) return res.status(401).json({ error: "Non connecté" });
    const { id, coche } = req.body;
    try {
        await pool.query("UPDATE courses SET coche = $1 WHERE id = $2 AND profil = $3", [coche ? 1 : 0, id, profil]);
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/courses/generer', async (req, res) => {
    const profil = req.session.user;
    if (!profil) return res.status(401).json({ error: "Non connecté" });

    try {
        const menusRes = await pool.query("SELECT * FROM menu_prevu WHERE profil = $1", [profil]);
        let idsRecettes = new Set();
        (menusRes.rows || []).forEach(m => ['petitDejeuner', 'repas1', 'repas2', 'dessertCollation'].forEach(c => { if (m[c]) idsRecettes.add(m[c]); }));
        
        if (idsRecettes.size === 0) return res.json({ success: true });

        const idsArray = Array.from(idsRecettes);
        const placeholders = idsArray.map((_, i) => `$${i + 1}`).join(',');
        const recettesRes = await pool.query(`SELECT * FROM recettes WHERE id IN (${placeholders})`, idsArray);
        const ingsRefRes = await pool.query("SELECT * FROM ingredients");

        let besoins = {};
        (recettesRes.rows || []).forEach(r => {
            try {
                let ings = typeof r.ingredients === 'string' ? JSON.parse(r.ingredients) : r.ingredients;
                if (Array.isArray(ings)) ings.forEach(i => {
                    let id = i.id || i.ingredient_id;
                    if (id) besoins[id] = (besoins[id] || 0) + parseFloat(i.quantite || 0);
                });
            } catch (e) {}
        });

        await pool.query("DELETE FROM courses WHERE profil = $1", [profil]);

        for (const [id, qte] of Object.entries(besoins)) {
            const ref = (ingsRefRes.rows || []).find(i => i.id == id);
            if (ref) {
                await pool.query(
                    "INSERT INTO courses (profil, ingredient_id, nom, rayon, quantite_necessaire, unite, prix_total, coche) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)",
                    [profil, ref.id, ref.nom, ref.rayon || 'Épicerie', qte, 'g', 0]
                );
            }
        }
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/frigo/recettes-faisables', async (req, res) => {
    const profil = req.session.user;
    if (!profil) return res.status(401).json({ error: "Non connecté" });

    try {
        const recettesRes = await pool.query("SELECT * FROM recettes");
        const coursesRes = await pool.query("SELECT ingredient_id FROM courses WHERE profil = $1 AND coche = 1", [profil]);
        
        const dispo = new Set((coursesRes.rows || []).map(c => c.ingredient_id));
        const faisables = (recettesRes.rows || []).filter(r => {
            try {
                let ings = typeof r.ingredients === 'string' ? JSON.parse(r.ingredients) : r.ingredients;
                return Array.isArray(ings) && ings.every(i => dispo.has(Number(i.id || i.ingredient_id)));
            } catch { return false; }
        });
        res.json(faisables);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));