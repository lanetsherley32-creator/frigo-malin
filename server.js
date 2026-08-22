const express = require('express');
const http = require('http');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session); // <--- AJOUTÉ

const app = express();
const server = http.createServer(app);
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

// --- CONFIGURATION DES SESSIONS (STOCKÉES DANS POSTGRES) ---
app.use(session({
    store: new pgSession({
        pool: pool,                // Utilise votre connexion Supabase
        tableName: 'session',      // Nom de la table en base de données
        createTableIfMissing: true // Crée la table automatiquement si absente
    }),
    secret: process.env.SESSION_SECRET || 'votre_secret_tres_securise_et_aleatoire',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24 * 7,
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true
    }
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
    host: process.env.SMTP_HOST || 'smtp.ethereal.email',
    port: process.env.SMTP_PORT || 587,
    auth: { 
        user: process.env.SMTP_USER || 'votre_email@example.com', 
        pass: process.env.SMTP_PASS || 'votre_mot_de_passe_smtp' 
    }
});

// --- GESTION SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('Un client est connecté via WebSocket');
    socket.on('disconnect', () => {
        // Déconnexion propre
    });
});

// --- API AUTHENTIFICATION & COMPTE UTILISATEUR ---
app.post('/api/login', async (req, res) => {
    const { email, mdp } = req.body;
    if (!email || !mdp) return res.status(400).json({ error: "E-mail et mot de passe requis." });

    try {
        const result = await pool.query("SELECT * FROM profils WHERE email = $1", [email]);
        const user = result.rows[0];
        if (user && user.mdp && await bcrypt.compare(mdp, user.mdp)) {
            req.session.user = user.email;
            res.json({ success: true, nom: user.nom });
        } else {
            res.status(401).json({ error: "E-mail ou mot de passe incorrect." });
        }
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
        console.error("ERREUR SIGNUP:", e);
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
        console.error("Erreur mise à jour compte :", error);
        res.status(500).json({ error: "Erreur serveur : " + error.message });
    }
});

// --- API PERSONNES / OBJECTIFS ---
app.get('/api/personnes-objectifs', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM personnes_objectifs");
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/personnes-objectifs', async (req, res) => {
    const { nom, ancienNom, calories, eau, budget, budget_periode, proteines, glucides, lipides } = req.body;
    try {
        if (ancienNom) {
            await pool.query(
                `UPDATE personnes_objectifs SET nom = $1, calories = $2, eau = $3, budget = $4, budget_periode = $5, proteines = $6, glucides = $7, lipides = $8 WHERE nom = $9`,
                [nom, calories || 0, eau || 0, budget || 0, budget_periode || 'semaine', proteines || 0, glucides || 0, lipides || 0, ancienNom]
            );
        } else {
            await pool.query(
                `INSERT INTO personnes_objectifs (nom, calories, eau, budget, budget_periode, proteines, glucides, lipides) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (nom) DO UPDATE SET 
                    calories = EXCLUDED.calories,
                    eau = EXCLUDED.eau,
                    budget = EXCLUDED.budget,
                    budget_periode = EXCLUDED.budget_periode,
                    proteines = EXCLUDED.proteines,
                    glucides = EXCLUDED.glucides,
                    lipides = EXCLUDED.lipides`,
                [nom, calories || 0, eau || 0, budget || 0, budget_periode || 'semaine', proteines || 0, glucides || 0, lipides || 0]
            );
        }
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        console.error("Erreur personnes_objectifs:", err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/personnes-objectifs', async (req, res) => {
    const nom = req.query.nom;
    if (!nom) return res.status(400).json({ error: "Nom manquant" });
    try {
        await pool.query("DELETE FROM personnes_objectifs WHERE nom = $1", [nom]);
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API MOT DE PASSE OUBLIÉ & RESET ---
app.post('/api/mot-de-passe-oublie', async (req, res) => {
    const { email } = req.body;
    try {
        const result = await pool.query("SELECT * FROM profils WHERE email = $1", [email]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: "Aucun compte associé à cet e-mail." });

        const token = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + 3600000;

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
        if (!user) return res.status(400).json({ error: "Token invalide ou expiré." });

        const hashedPassword = await bcrypt.hash(nouveauMdp, 10);
        await pool.query("UPDATE profils SET mdp = $1, reset_token = NULL, reset_expires = NULL WHERE nom = $2", [hashedPassword, user.nom]);
        res.json({ success: true, message: "Mot de passe mis à jour avec succès." });
    } catch (e) {
        res.status(500).json({ error: "Erreur lors de la mise à jour." });
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

// --- FONCTION UTILITAIRE DE CALCUL DE SCORE (NUTRITION & MACROS) ---
function calculerScoreEcart(recette, cible) {
    const calR = parseFloat(recette.calories) || 0;
    const proR = parseFloat(recette.proteines) || 0;
    const gluR = parseFloat(recette.glucides) || 0;
    const lipR = parseFloat(recette.lipides) || 0;

    let scoreCal = Math.abs(calR - cible.calories);
    if (calR > cible.calories) scoreCal *= 2; 

    let scorePro = proR >= cible.proteines ? 0 : (cible.proteines - proR) * 2.5;

    let scoreGlu = gluR > cible.glucides ? (gluR - cible.glucides) * 2 : Math.abs(gluR - cible.glucides) * 0.5;
    let scoreLip = lipR > cible.lipides ? (lipR - cible.lipides) * 2 : Math.abs(lipR - cible.lipides) * 0.5;

    return scoreCal + scorePro + scoreGlu + scoreLip;
}

// --- API MENU PRÉVU & GÉNÉRATION ALÉATOIRE OPTIMISÉE ---
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

// --- API RÉSUMÉ DU JOUR (PLANIFICATION SEMAINE) ---
app.get('/api/menu-prevu-resume-jour', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil || !jour) return res.status(400).json({ error: "Profil ou jour manquant" });
    
    try {
        const menuRes = await pool.query(
            "SELECT petitDejeuner, repas1, repas2, dessertCollation FROM menu_prevu WHERE profil = $1 AND jour = $2", 
            [profil, jour]
        );
        const menu = menuRes.rows[0];
        
        if (!menu) {
            return res.json({ calories: 0, proteines: 0, glucides: 0, lipides: 0, cout: 0 });
        }
        
        const idsRecettes = [menu.petitdejeuner || menu.petitDejeuner, menu.repas1, menu.repas2, menu.dessertcollation || menu.dessertCollation].filter(Boolean);
        
        if (idsRecettes.length === 0) {
            return res.json({ calories: 0, proteines: 0, glucides: 0, lipides: 0, cout: 0 });
        }
        
        const placeholders = idsRecettes.map((_, i) => `$${i + 1}`).join(',');
        const recettesRes = await pool.query(`SELECT calories, proteines, glucides, lipides, cout FROM recettes WHERE id IN (${placeholders})`, idsRecettes);
        
        let totaux = { calories: 0, proteines: 0, glucides: 0, lipides: 0, cout: 0 };
        
        recettesRes.rows.forEach(r => {
            totaux.calories += parseFloat(r.calories) || 0;
            totaux.proteines += parseFloat(r.proteines) || 0;
            totaux.glucides += parseFloat(r.glucides) || 0;
            totaux.lipides += parseFloat(r.lipides) || 0;
            totaux.cout += parseFloat(r.cout) || 0;
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
        INSERT INTO menu_prevu (profil, jour, petitDejeuner, repas1, repas2, dessertCollation) 
        VALUES ($1, $2, $3, $4, $5, $6) 
        ON CONFLICT (profil, jour) DO UPDATE SET 
            petitDejeuner = EXCLUDED.petitDejeuner, 
            repas1 = EXCLUDED.repas1, 
            repas2 = EXCLUDED.repas2, 
            dessertCollation = EXCLUDED.dessertCollation
    `;
    try {
        await pool.query(q, [profil, jour, petitDejeuner || null, repas1 || null, repas2 || null, dessertCollation || null]);
        io.emit('data_updated');
        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/menu-aleatoire-optimise', async (req, res) => {
    const { profil } = req.body;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });

    try {
        const objRes = await pool.query("SELECT * FROM personnes_objectifs WHERE nom = $1", [profil]);
        const obj = objRes.rows[0] || {};
        
        const cibleJour = {
            calories: parseFloat(obj.calories) || 2000,
            proteines: parseFloat(obj.proteines) || 120,
            glucides: parseFloat(obj.glucides) || 200,
            lipides: parseFloat(obj.lipides) || 70
        };

        const recettesRes = await pool.query("SELECT * FROM recettes");
        const recettes = recettesRes.rows || [];
        if (recettes.length === 0) return res.status(400).json({ error: "Aucune recette disponible." });

        const jours = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
        const ratios = [0.20, 0.35, 0.35, 0.10]; 
        const repasKeys = ['petitDejeuner', 'repas1', 'repas2', 'dessertCollation'];

        for (const jour of jours) {
            let selection = {};

            for (let i = 0; i < repasKeys.length; i++) {
                const ratio = ratios[i];
                const sousCible = {
                    calories: cibleJour.calories * ratio,
                    proteines: cibleJour.proteines * ratio,
                    glucides: cibleJour.glucides * ratio,
                    lipides: cibleJour.lipides * ratio
                };

                const recettesTriees = [...recettes].sort((a, b) => {
                    return calculerScoreEcart(a, sousCible) - calculerScoreEcart(b, sousCible);
                });

                const topChoices = recettesTriees.slice(0, Math.min(3, recettesTriees.length));
                const chosen = topChoices[Math.floor(Math.random() * topChoices.length)] || recettesTriees[0];

                selection[repasKeys[i]] = chosen ? chosen.id : null;
            }

            const q = `
                INSERT INTO menu_prevu (profil, jour, petitDejeuner, repas1, repas2, dessertCollation) 
                VALUES ($1, $2, $3, $4, $5, $6) 
                ON CONFLICT (profil, jour) DO UPDATE SET 
                    petitDejeuner = EXCLUDED.petitDejeuner, 
                    repas1 = EXCLUDED.repas1, 
                    repas2 = EXCLUDED.repas2, 
                    dessertCollation = EXCLUDED.dessertCollation
            `;
            await pool.query(q, [profil, jour, selection.petitDejeuner, selection.repas1, selection.repas2, selection.dessertCollation]);
        }

        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API SUGGESTION "POUR COMPLÉTER VOTRE OBJECTIF" ---
app.get('/api/recette-suggeree-complement', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil || !jour) return res.status(400).json({ error: "Profil ou jour manquant" });

    try {
        const objRes = await pool.query("SELECT * FROM personnes_objectifs WHERE nom = $1", [profil]);
        const obj = objRes.rows[0] || {};
        const objectifTotal = {
            calories: parseFloat(obj.calories) || 2000,
            proteines: parseFloat(obj.proteines) || 120,
            glucides: parseFloat(obj.glucides) || 200,
            lipides: parseFloat(obj.lipides) || 70
        };

        const consoRes = await pool.query(`
            SELECT 
                COALESCE(SUM(COALESCE(r.calories, i.calories, 0) * s.quantite / 100), 0) as calories,
                COALESCE(SUM(COALESCE(r.proteines, i.proteines, 0) * s.quantite / 100), 0) as proteines,
                COALESCE(SUM(COALESCE(r.glucides, i.glucides, 0) * s.quantite / 100), 0) as glucides,
                COALESCE(SUM(COALESCE(r.lipides, i.lipides, 0) * s.quantite / 100), 0) as lipides
            FROM suivi_conso s
            LEFT JOIN recettes r ON s.type_element = 'recette' AND s.element_id = r.id
            LEFT JOIN ingredients i ON s.type_element = 'aliment' AND s.element_id = i.id
            WHERE s.profil = $1 AND s.jour = $2
        `, [profil, jour]);

        const consomme = consoRes.rows[0] || { calories: 0, proteines: 0, glucides: 0, lipides: 0 };

        const resteCible = {
            calories: Math.max(0, objectifTotal.calories - parseFloat(consomme.calories)),
            proteines: Math.max(0, objectifTotal.proteines - parseFloat(consomme.proteines)),
            glucides: Math.max(0, objectifTotal.glucides - parseFloat(consomme.glucides)),
            lipides: Math.max(0, objectifTotal.lipides - parseFloat(consomme.lipides))
        };

        const recettesRes = await pool.query("SELECT * FROM recettes");
        const recettes = recettesRes.rows || [];
        if (recettes.length === 0) return res.json({ suggestion: null });

        let meilleureRecette = null;
        let meilleurScore = Infinity;

        for (const recette of recettes) {
            const score = calculerScoreEcart(recette, resteCible);
            if (score < meilleurScore) {
                meilleurScore = score;
                meilleureRecette = recette;
            }
        }

        res.json({
            resteCible,
            suggestion: meilleureRecette
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API SUIVI RÉEL & EAU ---
app.get('/api/suivi-conso', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil) return res.json([]);
    try {
        const query = `
            SELECT s.*, 
                   COALESCE(r.nom, i.nom) as nom_element,
                   COALESCE(r.calories, i.calories) as calories,
                   COALESCE(r.proteines, i.proteines) as proteines,
                   COALESCE(r.glucides, i.glucides) as glucides,
                   COALESCE(r.lipides, i.lipides) as lipides
            FROM suivi_conso s
            LEFT JOIN recettes r ON s.type_element = 'recette' AND s.element_id = r.id
            LEFT JOIN ingredients i ON s.type_element = 'aliment' AND s.element_id = i.id
            WHERE s.profil = $1 AND s.jour = $2
        `;
        const result = await pool.query(query, [profil, jour]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/suivi-conso-semaine', async (req, res) => {
    const profil = req.query.profil;
    if (!profil) return res.json({ repas: [], eau: [] });
    try {
        const query = `
            SELECT s.*, 
                   COALESCE(r.calories, i.calories) as calories,
                   COALESCE(r.proteines, i.proteines) as proteines,
                   COALESCE(r.glucides, i.glucides) as glucides,
                   COALESCE(r.lipides, i.lipides) as lipides
            FROM suivi_conso s
            LEFT JOIN recettes r ON s.type_element = 'recette' AND s.element_id = r.id
            LEFT JOIN ingredients i ON s.type_element = 'aliment' AND s.element_id = i.id
            WHERE s.profil = $1
        `;
        const resRepas = await pool.query(query, [profil]);
        const resEau = await pool.query("SELECT * FROM suivi_eau WHERE profil = $1", [profil]);
        res.json({ repas: resRepas.rows || [], eau: resEau.rows || [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/suivi-conso', async (req, res) => {
    const { profil, jour, categorie, type_element, element_id, quantite } = req.body;
    try {
        const q = `INSERT INTO suivi_conso (profil, jour, categorie, type_element, element_id, quantite) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
        const result = await pool.query(q, [profil, jour, categorie, type_element, element_id, quantite]);
        io.emit('data_updated');
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/suivi-conso/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM suivi_conso WHERE id = $1", [req.params.id]);
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/suivi-eau', async (req, res) => {
    const { profil, jour } = req.query;
    try {
        const r = await pool.query("SELECT * FROM suivi_eau WHERE profil = $1 AND jour = $2", [profil, jour]);
        res.json(r.rows[0] || { quantite: 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/suivi-eau', async (req, res) => {
    const { profil, jour, quantite } = req.body;
    try {
        const q = `
            INSERT INTO suivi_eau (profil, jour, quantite) VALUES ($1, $2, $3)
            ON CONFLICT (profil, jour) DO UPDATE SET quantite = EXCLUDED.quantite
        `;
        await pool.query(q, [profil, jour, quantite]);
        io.emit('data_updated');
        res.sendStatus(200);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API COURSES ---
app.get('/api/courses', async (req, res) => {
    const profil = req.query.profil || req.session.user;
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
        await pool.query("UPDATE courses SET coche = $1 WHERE id = $2", [coche ? 1 : 0, id]);
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/courses/generer', async (req, res) => {
    const profil = req.body.profil || req.session.user;
    if (!profil) return res.status(401).json({ error: "Non connecté" });

    try {
        const menusRes = await pool.query("SELECT * FROM menu_prevu WHERE profil = $1", [profil]);
        let idsRecettes = new Set();
        (menusRes.rows || []).forEach(m => {
            ['petitdejeuner', 'repas1', 'repas2', 'dessertcollation', 'petitDejeuner', 'dessertCollation'].forEach(c => { if (m[c]) idsRecettes.add(m[c]); });
        });
        
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
                    if (id) {
                        if (!besoins[id]) besoins[id] = { qte: 0, unite: i.unite || 'g' };
                        besoins[id].qte += parseFloat(i.quantite || 0);
                    }
                });
            } catch (e) {}
        });

        await pool.query("DELETE FROM courses WHERE profil = $1", [profil]);

        for (const [id, data] of Object.entries(besoins)) {
            const ref = (ingsRefRes.rows || []).find(i => i.id == id);
            if (ref) {
                await pool.query(
                    "INSERT INTO courses (profil, ingredient_id, nom, rayon, quantite_necessaire, unite, prix_total, coche) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)",
                    [profil, ref.id, ref.nom, ref.rayon || 'Épicerie', data.qte, data.unite, 0]
                );
            }
        }
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));