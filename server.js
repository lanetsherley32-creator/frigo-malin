const express = require('express');
const http = require('http');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

// --- CONNEXION POSTGRESQL (SUPABASE) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURATION DES SESSIONS ---
app.use(session({
    store: new pgSession({
        pool: pool,                
        tableName: 'session',      
        createTableIfMissing: true 
    }),
    secret: process.env.SESSION_SECRET || 'votre_secret_tres_securise_et_aleatoire',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24 * 30, // 30 jours
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// --- MIDDLEWARE DE PROTECTION ---
app.use((req, res, next) => {
    const cheminsPublics = [
        '/login.html', '/forgot.html', '/reset.html', 
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

// --- FICHIERS STATIQUES ---
app.use(express.static('public'));

app.get('/', (req, res) => {
    if (req.session.user) {
        res.sendFile(__dirname + '/public/global.html');
    } else {
        res.sendFile(__dirname + '/public/login.html');
    }
});

// --- CONFIGURATION EMAIL ---
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    port: process.env.SMTP_PORT || 587,
    auth: { 
        user: process.env.SMTP_USER || '', 
        pass: process.env.SMTP_PASS || '' 
    }
});

// --- GESTION SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('Un client est connecté via WebSocket');
    socket.on('disconnect', () => {});
});

// --- API AUTHENTIFICATION ---
app.post('/api/login', async (req, res) => {
    const { email, mdp } = req.body;
    if (!email || !mdp) return res.status(400).json({ error: "E-mail et mot de passe requis." });

    try {
        const result = await pool.query("SELECT * FROM profils WHERE email = $1", [email]);
        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(mdp, user.mdp))) {
            return res.status(401).json({ error: "E-mail ou mot de passe incorrect." });
        }

        req.session.user = user.email;
        res.json({ success: true, nom: user.nom });
    } catch (err) {
        console.error("ERREUR LOGIN:", err);
        res.status(500).json({ error: "Erreur serveur interne." });
    }
});

app.post('/api/logout', (req, res) => { 
    req.session.destroy(() => res.json({ success: true })); 
});

app.get('/api/current-user', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Non connecté" });
    try {
        const result = await pool.query("SELECT nom, email FROM profils WHERE email = $1", [req.session.user]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: "Compte introuvable" });
        res.json(user);
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
            ON CONFLICT (email) DO UPDATE SET 
                nom = EXCLUDED.nom, 
                mdp = COALESCE(EXCLUDED.mdp, profils.mdp)
        `;
        await pool.query(query, [nom, email, hashedPassword]);
        req.session.user = email;
        io.emit('data_updated');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || "Erreur inconnue" });
    }
});

app.put('/api/profils', async (req, res) => {
    const emailActuel = req.session.user;
    if (!emailActuel) return res.status(401).json({ error: "Non connecté" });

    const { nom, email, mdp } = req.body;
    try {
        let query = `UPDATE profils SET nom = $1, email = $2`;
        let values = [nom, email];

        if (mdp && mdp.trim() !== '') {
            const hashedPassword = await bcrypt.hash(mdp, 10);
            query += `, mdp = $3 WHERE email = $4`;
            values.push(hashedPassword, emailActuel);
        } else {
            query += ` WHERE email = $3`;
            values.push(emailActuel);
        }

        await pool.query(query, values);
        req.session.user = email;
        io.emit('data_updated');
        res.json({ success: true, message: "Compte mis à jour avec succès !" });
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur : " + error.message });
    }
});

// --- API MOT DE PASSE OUBLIÉ & RESET ---
app.post('/api/mot-de-passe-oublie', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Veuillez entrer une adresse e-mail." });

    try {
        const result = await pool.query("SELECT * FROM profils WHERE email = $1", [email]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: "Pas de compte associé à cet e-mail." });

        const token = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + 3600000;

        await pool.query("UPDATE profils SET reset_token = $1, reset_expires = $2 WHERE email = $3", [token, expires, email]);
        
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const resetLink = `${protocol}://${req.get('host')}/reset.html?token=${token}`;
        
        try {
            await transporter.sendMail({
                from: '"Frigomalin" <noreply@frigomalin.com>',
                to: email,
                subject: 'Réinitialisation de votre mot de passe',
                text: `Bonjour, cliquez sur ce lien pour réinitialiser votre mot de passe : ${resetLink}`
            });
            res.json({ success: true, message: "Mail de réinitialisation envoyé." });
        } catch (mailErr) {
            res.json({ success: true, message: "Mail envoyé.", debug_link: resetLink });
        }
    } catch (err) {
        res.status(500).json({ error: "Échec." });
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, nouveauMdp } = req.body;
    try {
        const result = await pool.query("SELECT * FROM profils WHERE reset_token = $1 AND reset_expires > $2", [token, Date.now()]);
        const user = result.rows[0];
        if (!user) return res.status(400).json({ error: "Token invalide ou expiré." });

        const hashedPassword = await bcrypt.hash(nouveauMdp, 10);
        await pool.query("UPDATE profils SET mdp = $1, reset_token = NULL, reset_expires = NULL WHERE email = $2", [hashedPassword, user.email]);
        res.json({ success: true, message: "Mot de passe mis à jour avec succès." });
    } catch (e) {
        res.status(500).json({ error: "Erreur lors de la mise à jour." });
    }
});

// --- API PERSONNES / OBJECTIFS ---
app.get('/api/personnes-objectifs', async (req, res) => {
    const compteEmail = req.session.user;
    if (!compteEmail) return res.status(401).json({ error: "Non connecté" });

    try {
        const result = await pool.query("SELECT * FROM personnes_objectifs WHERE compte_email = $1", [compteEmail]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/personnes-objectifs', async (req, res) => {
    const compteEmail = req.session.user;
    if (!compteEmail) return res.status(401).json({ error: "Non connecté" });

    const { nom, ancienNom, calories, eau, budget, budget_periode, proteines, glucides, lipides, fibres, sucre } = req.body;
    if (!nom) return res.status(400).json({ error: "Le nom est requis." });

    try {
        const cibleNom = ancienNom || nom;
        const check = await pool.query("SELECT id FROM personnes_objectifs WHERE compte_email = $1 AND nom = $2", [compteEmail, cibleNom]);

        if (check.rows.length > 0) {
            await pool.query(
                `UPDATE personnes_objectifs SET nom = $1, calories = $2, eau = $3, budget = $4, budget_periode = $5, proteines = $6, glucides = $7, lipides = $8, fibres = $9, sucre = $10 WHERE compte_email = $11 AND nom = $12`,
                [nom, calories || 0, eau || 0, budget || 0, budget_periode || 'semaine', proteines || 0, glucides || 0, lipides || 0, fibres || 0, sucre || 0, compteEmail, cibleNom]
            );
        } else {
            await pool.query(
                `INSERT INTO personnes_objectifs (compte_email, nom, calories, eau, budget, budget_periode, proteines, glucides, lipides, fibres, sucre) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [compteEmail, nom, calories || 0, eau || 0, budget || 0, budget_periode || 'semaine', proteines || 0, glucides || 0, lipides || 0, fibres || 0, sucre || 0]
            );
        }
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/personnes-objectifs', async (req, res) => {
    const compteEmail = req.session.user;
    if (!compteEmail) return res.status(401).json({ error: "Non connecté" });
    const nom = req.query.nom;
    if (!nom) return res.status(400).json({ error: "Nom manquant" });

    try {
        await pool.query("DELETE FROM personnes_objectifs WHERE compte_email = $1 AND nom = $2", [compteEmail, nom]);
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API RECETTES & INGREDIENTS ---
app.get('/api/recettes', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM recettes");
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/recettes', async (req, res) => {
    const { nom, categorie, parts, ingredients, etapes, cout, calories, proteines, glucides, lipides, fibres, sucre } = req.body;
    let ingredientsToSave = Array.isArray(ingredients) ? JSON.stringify(ingredients) : (typeof ingredients === 'string' ? ingredients : JSON.stringify([]));

    try {
        const query = `
            INSERT INTO recettes (nom, categorie, parts, ingredients, etapes, cout, calories, proteines, glucides, lipides, fibres, sucre) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id
        `;
        const result = await pool.query(query, [nom, categorie, parts, ingredientsToSave, etapes, cout, calories, proteines, glucides, lipides, fibres || 0, sucre || 0]);
        io.emit('data_updated');
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route PUT pour modifier une recette (Ajoutée)
app.put('/api/recettes/:id', async (req, res) => {
    const { id } = req.params;
    const { nom, categorie, parts, ingredients, etapes, cout, calories, proteines, glucides, lipides, fibres, sucre } = req.body;
    let ingredientsToSave = Array.isArray(ingredients) ? JSON.stringify(ingredients) : (typeof ingredients === 'string' ? ingredients : JSON.stringify([]));

    try {
        const query = `
            UPDATE recettes SET nom = $1, categorie = $2, parts = $3, ingredients = $4, etapes = $5, 
                cout = $6, calories = $7, proteines = $8, glucides = $9, lipides = $10, fibres = $11, sucre = $12 
            WHERE id = $13
        `;
        await pool.query(query, [nom, categorie, parts, ingredientsToSave, etapes, cout, calories, proteines, glucides, lipides, fibres || 0, sucre || 0, id]);
        io.emit('data_updated');
        res.json({ success: true, message: "Recette mise à jour avec succès !" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route DELETE pour supprimer une recette (Ajoutée)
app.delete('/api/recettes/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM recettes WHERE id = $1", [id]);
        io.emit('data_updated');
        res.json({ success: true, message: "Recette supprimée avec succès !" });
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
    const { nom, rayon, calories, proteines, glucides, lipides, fibres, sucre, prix, marques } = req.body;
    const marquesStr = Array.isArray(marques) ? JSON.stringify(marques) : (marques || '[]');
    
    try {
        const query = `
            INSERT INTO ingredients (nom, rayon, calories, proteines, glucides, lipides, fibres, sucre, prix, marques) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
        `;
        const result = await pool.query(query, [nom, rayon || 'Épicerie', calories || 0, proteines || 0, glucides || 0, lipides || 0, fibres || 0, sucre || 0, prix || 0, marquesStr]);
        io.emit('data_updated');
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/ingredients/:id', async (req, res) => {
    const { id } = req.params;
    const { nom, rayon, calories, proteines, glucides, lipides, fibres, sucre, prix, marques } = req.body;
    const marquesStr = Array.isArray(marques) ? JSON.stringify(marques) : (marques || '[]');
    
    try {
        const query = `
            UPDATE ingredients SET nom = $1, rayon = $2, calories = $3, proteines = $4, glucides = $5, 
                lipides = $6, fibres = $7, sucre = $8, prix = $9, marques = $10 WHERE id = $11
        `;
        await pool.query(query, [nom, rayon || 'Épicerie', calories || 0, proteines || 0, glucides || 0, lipides || 0, fibres || 0, sucre || 0, prix || 0, marquesStr, id]);
        io.emit('data_updated');
        res.json({ success: true, message: "Mis à jour avec succès !" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route DELETE pour supprimer un ingrédient (Ajoutée)
app.delete('/api/ingredients/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM ingredients WHERE id = $1", [id]);
        io.emit('data_updated');
        res.json({ success: true, message: "Ingrédient supprimé avec succès !" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API RECHERCHE GLOBALE ---
app.get('/api/recherche-globale', async (req, res) => {
    const { q, profil, jour, categories } = req.query;
    const termeRecherche = (q || '').toLowerCase().trim();

    try {
        let cible = { calories: 2000, proteines: 120, glucides: 200, lipides: 70, fibres: 30, sucre: 50, budget: 100 };
        let consomme = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 };

        if (profil) {
            const objRes = await pool.query("SELECT * FROM personnes_objectifs WHERE nom = $1", [profil]);
            if (objRes.rows.length > 0) {
                const obj = objRes.rows[0];
                cible = {
                    calories: parseFloat(obj.calories) || 2000,
                    proteines: parseFloat(obj.proteines) || 120,
                    glucides: parseFloat(obj.glucides) || 200,
                    lipides: parseFloat(obj.lipides) || 70,
                    fibres: parseFloat(obj.fibres) || 30,
                    sucre: parseFloat(obj.sucre) || 50,
                    budget: parseFloat(obj.budget) || 100
                };
            }

            if (jour) {
                const suiviRes = await pool.query(`
                    SELECT s.quantite,
                           COALESCE(r.parts, 1) as parts,
                           COALESCE(r.calories, i.calories) as calories,
                           COALESCE(r.proteines, i.proteines) as proteines,
                           COALESCE(r.glucides, i.glucides) as glucides,
                           COALESCE(r.lipides, i.lipides) as lipides,
                           COALESCE(r.fibres, i.fibres) as fibres,
                           COALESCE(r.sucre, i.sucre) as sucre,
                           COALESCE(r.cout, i.prix, 0) as cout
                    FROM suivi_conso s
                    LEFT JOIN recettes r ON s.type_element = 'recette' AND s.element_id = r.id
                    LEFT JOIN ingredients i ON s.type_element = 'ingredient' AND s.element_id = i.id
                    WHERE s.profil = $1 AND s.jour = $2
                `, [profil, jour]);

                suiviRes.rows.forEach(row => {
                    const qte = parseFloat(row.quantite) || 1;
                    const ratioPart = 1 / (parseFloat(row.parts) || 1);
                    consomme.calories += (parseFloat(row.calories) || 0) * ratioPart * qte;
                    consomme.proteines += (parseFloat(row.proteines) || 0) * ratioPart * qte;
                    consomme.glucides += (parseFloat(row.glucides) || 0) * ratioPart * qte;
                    consomme.lipides += (parseFloat(row.lipides) || 0) * ratioPart * qte;
                    consomme.fibres += (parseFloat(row.fibres) || 0) * ratioPart * qte;
                    consomme.sucre += (parseFloat(row.sucre) || 0) * ratioPart * qte;
                    consomme.cout += (parseFloat(row.cout) || 0) * ratioPart * qte;
                });
            }
        }

        let categoriesFiltre = categories ? (Array.isArray(categories) ? categories : categories.split(',').map(c => c.trim().toLowerCase())) : [];

        const recettesRes = await pool.query("SELECT * FROM recettes");
        let recettes = recettesRes.rows.map(r => ({ ...r, type: 'recette', marques: [] })).filter(r => {
            const matchNom = r.nom.toLowerCase().includes(termeRecherche);
            const matchCat = categoriesFiltre.length === 0 || (r.categorie && categoriesFiltre.includes(r.categorie.toLowerCase()));
            return matchNom && matchCat;
        });

        const ingredientsRes = await pool.query("SELECT * FROM ingredients");
        let ingredients = ingredientsRes.rows.map(i => ({
            ...i,
            type: 'ingredient',
            parts: 1,
            cout: i.prix || 0,
            categorie: i.rayon || 'Épicerie',
            marques: i.marques ? JSON.parse(i.marques) : []
        })).filter(i => {
            const matchNom = i.nom.toLowerCase().includes(termeRecherche);
            const matchCat = categoriesFiltre.length === 0 || (i.rayon && categoriesFiltre.includes(i.rayon.toLowerCase()));
            return matchNom && matchCat;
        });

        let tousLesChoix = [...recettes, ...ingredients].map(item => {
            const parts = parseFloat(item.parts) || 1;
            const ratioPart = 1 / parts;
            const cal = (parseFloat(item.calories) || 0) * ratioPart;
            const pro = (parseFloat(item.proteines) || 0) * ratioPart;
            const glu = (parseFloat(item.glucides) || 0) * ratioPart;
            const lip = (parseFloat(item.lipides) || 0) * ratioPart;
            const fib = (parseFloat(item.fibres) || 0) * ratioPart;
            const suc = (parseFloat(item.sucre) || 0) * ratioPart;

            let penalite = 0;
            if ((consomme.calories + cal) > cible.calories) penalite += ((consomme.calories + cal) - cible.calories) * 2;
            if ((consomme.lipides + lip) > cible.lipides) penalite += ((consomme.lipides + lip) - cible.lipides) * 2;
            if ((consomme.sucre + suc) > cible.sucre) penalite += ((consomme.sucre + suc) - cible.sucre) * 3;

            return {
                ...item,
                scoreRecommandation: penalite,
                recommandeEnVert: (consomme.proteines < cible.proteines && pro >= 10)
            };
        });

        tousLesChoix.sort((a, b) => a.scoreRecommandation - b.scoreRecommandation);
        res.json(tousLesChoix);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API MENU PRÉVU (PLANIFICATION) ---
app.get('/api/menu-prevu-semaine', async (req, res) => {
    const profil = req.query.profil;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });
    try {
        const result = await pool.query("SELECT * FROM menu_prevu WHERE profil = $1", [profil]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/menu-prevu-resume-jour', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil || !jour) return res.status(400).json({ error: "Paramètres manquants" });
    
    try {
        const menuRes = await pool.query("SELECT petitdejeuner, repas1, repas2, dessertcollation FROM menu_prevu WHERE profil = $1 AND jour = $2", [profil, jour]);
        const menu = menuRes.rows[0];
        if (!menu) return res.json({ calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 });
        
        const idsRecettes = [menu.petitdejeuner, menu.repas1, menu.repas2, menu.dessertcollation].filter(Boolean);
        if (idsRecettes.length === 0) return res.json({ calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 });
        
        const placeholders = idsRecettes.map((_, i) => `$${i + 1}`).join(',');
        const recettesRes = await pool.query(`SELECT parts, calories, proteines, glucides, lipides, fibres, sucre, cout FROM recettes WHERE id IN (${placeholders})`, idsRecettes);
        
        let totaux = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 };
        recettesRes.rows.forEach(r => {
            const ratioPart = 1 / (parseFloat(r.parts) || 1);
            totaux.calories += (parseFloat(r.calories) || 0) * ratioPart;
            totaux.proteines += (parseFloat(r.proteines) || 0) * ratioPart;
            totaux.glucides += (parseFloat(r.glucides) || 0) * ratioPart;
            totaux.lipides += (parseFloat(r.lipides) || 0) * ratioPart;
            totaux.fibres += (parseFloat(r.fibres) || 0) * ratioPart;
            totaux.sucre += (parseFloat(r.sucre) || 0) * ratioPart;
            totaux.cout += (parseFloat(r.cout) || 0) * ratioPart;
        });
        
        res.json(totaux);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/menu-prevu', async (req, res) => {
    const { profil, jour, petitDejeuner, repas1, repas2, dessertCollation } = req.body;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });

    const q = `
        INSERT INTO menu_prevu (profil, jour, petitdejeuner, repas1, repas2, dessertcollation) 
        VALUES ($1, $2, $3, $4, $5, $6) 
        ON CONFLICT (profil, jour) DO UPDATE SET 
            petitdejeuner = EXCLUDED.petitdejeuner, 
            repas1 = EXCLUDED.repas1, 
            repas2 = EXCLUDED.repas2, 
            dessertcollation = EXCLUDED.dessertcollation
    `;
    try {
        await pool.query(q, [profil, jour, petitDejeuner || null, repas1 || null, repas2 || null, dessertCollation || null]);
        io.emit('data_updated');
        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API SUIVI (JOURNALIER) ---
app.get('/api/suivi', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil || !jour) return res.status(400).json({ error: "Paramètres manquants" });
    try {
        const result = await pool.query("SELECT * FROM suivi_conso WHERE profil = $1 AND jour = $2", [profil, jour]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/suivi', async (req, res) => {
    const { profil, jour, categorie, nom_element, element_id, type_element, quantite, unite } = req.body;
    if (!profil || !jour) return res.status(400).json({ error: "Données incomplètes" });

    try {
        await pool.query(
            `INSERT INTO suivi_conso (profil, jour, categorie, nom_element, element_id, type_element, quantite, unite) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                profil, 
                jour, 
                categorie || 'repas1', 
                nom_element || '', 
                element_id || null, 
                type_element || 'recette', 
                quantite !== undefined ? quantite : 1, 
                unite || 'portion'
            ]
        );
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        console.error("Erreur API /api/suivi :", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/suivi/:id', async (req, res) => {
    const id = req.params.id || req.query.id;
    if (!id) return res.status(400).json({ error: "ID manquant" });
    try {
        await pool.query("DELETE FROM suivi_conso WHERE id = $1", [id]);
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.put('/api/suivi/:id', async (req, res) => {
    const { id } = req.params;
    const { profil, jour, categorie, nom_element, element_id, type_element, quantite, unite } = req.body;
    if (!profil || !jour) return res.status(400).json({ error: "Données incomplètes" });

    try {
        await pool.query(
            `UPDATE suivi_conso SET profil = $1, jour = $2, categorie = $3, nom_element = $4, element_id = $5, type_element = $6, quantite = $7, unite = $8 WHERE id = $9`,
            [
                profil, 
                jour, 
                categorie || 'repas1', 
                nom_element || '', 
                element_id || null, 
                type_element || 'recette', 
                quantite !== undefined ? quantite : 1, 
                unite || 'portion',
                id
            ]
        );
        io.emit('data_updated');
        res.json({ success: true, message: "Consommation mise à jour avec succès !" });
    } catch (err) {
        console.error("Erreur API PUT /api/suivi :", err.message);
        res.status(500).json({ error: err.message });
    }
});
// --- API BILAN SEMAINE RÉEL ---
app.get('/api/suivi-semaine', async (req, res) => {
    const { profil } = req.query;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });

    try {
        const suiviRes = await pool.query(`
            SELECT s.quantite,
                   COALESCE(r.parts, 1) as parts,
                   COALESCE(r.calories, i.calories) as calories,
                   COALESCE(r.proteines, i.proteines) as proteines,
                   COALESCE(r.glucides, i.glucides) as glucides,
                   COALESCE(r.lipides, i.lipides) as lipides,
                   COALESCE(r.fibres, i.fibres) as fibres,
                   COALESCE(r.sucre, i.sucre) as sucre,
                   COALESCE(r.cout, i.prix, 0) as cout
            FROM suivi_conso s
            LEFT JOIN recettes r ON s.type_element = 'recette' AND s.element_id = r.id
            LEFT JOIN ingredients i ON s.type_element = 'ingredient' AND s.element_id = i.id
            WHERE s.profil = $1
        `, [profil]);

        let totaux = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, budget: 0 };
        suiviRes.rows.forEach(row => {
            const qte = parseFloat(row.quantite) || 1;
            const ratioPart = 1 / (parseFloat(row.parts) || 1);
            totaux.calories += (parseFloat(row.calories) || 0) * ratioPart * qte;
            totaux.proteines += (parseFloat(row.proteines) || 0) * ratioPart * qte;
            totaux.glucides += (parseFloat(row.glucides) || 0) * ratioPart * qte;
            totaux.lipides += (parseFloat(row.lipides) || 0) * ratioPart * qte;
            totaux.fibres += (parseFloat(row.fibres) || 0) * ratioPart * qte;
            totaux.sucre += (parseFloat(row.sucre) || 0) * ratioPart * qte;
            totaux.budget += (parseFloat(row.cout) || 0) * ratioPart * qte;
        });

        res.json(totaux);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API EAU ---
app.get('/api/eau', async (req, res) => {
    const { profil, jour } = req.query;
    try {
        const result = await pool.query("SELECT quantite FROM suivi_eau WHERE profil = $1 AND jour = $2", [profil, jour]);
        res.json({ quantite: result.rows[0]?.quantite || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/eau', async (req, res) => {
    const { profil, jour, quantite } = req.body;
    try {
        await pool.query(
            `INSERT INTO suivi_eau (profil, jour, quantite) VALUES ($1, $2, $3) ON CONFLICT (profil, jour) DO UPDATE SET quantite = EXCLUDED.quantite`,
            [profil, jour, quantite]
        );
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- LANCEMENT DU SERVEUR ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});