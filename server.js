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
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 jours
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// --- FICHIERS STATIQUES (AVANT LA PROTECTION) ---
app.use(express.static('public'));

// --- MIDDLEWARE DE PROTECTION ---
app.use((req, res, next) => {
    const cheminsPublics = [
        '/', '/index.html', '/login.html', '/forgot.html', '/reset.html', 
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

// --- CONFIGURATION EMAIL (BREVO / SMTP) ---
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

        if (!user) {
            return res.status(401).json({ error: "E-mail ou mot de passe incorrect." });
        }

        const match = await bcrypt.compare(mdp, user.mdp);

        if (match) {
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
                from: '"Menu de la Semaine" <noreply@menudesemaine.com>',
                to: email,
                subject: 'Réinitialisation de votre mot de passe',
                text: `Bonjour, cliquez sur ce lien pour réinitialiser votre mot de passe : ${resetLink}`
            });
            
            res.json({ success: true, message: "Mail de réinitialisation de mdp envoyé." });
        } catch (mailErr) {
            console.error("ERREUR SMTP (Brevo) :", mailErr.message);
            console.log("=== LIEN DE SECOURS ===", resetLink);
            res.json({ 
                success: true, 
                message: "Mail de réinitialisation de mdp envoyé.",
                debug_link: resetLink 
            });
        }
    } catch (err) {
        console.error("ERREUR MDP OUBLIE:", err);
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
        console.error("ERREUR RESET PASSWORD:", e);
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
    if (!nom) return res.status(400).json({ error: "Le nom de la personne est requis." });

    try {
        const cibleNom = ancienNom || nom;
        
        const check = await pool.query(
            "SELECT id FROM personnes_objectifs WHERE compte_email = $1 AND nom = $2", 
            [compteEmail, cibleNom]
        );

        if (check.rows.length > 0) {
            await pool.query(
                `UPDATE personnes_objectifs 
                 SET nom = $1, calories = $2, eau = $3, budget = $4, budget_periode = $5, proteines = $6, glucides = $7, lipides = $8, fibres = $9, sucre = $10 
                 WHERE compte_email = $11 AND nom = $12`,
                [nom, calories || 0, eau || 0, budget || 0, budget_periode || 'semaine', proteines || 0, glucides || 0, lipides || 0, fibres || 0, sucre || 0, compteEmail, cibleNom]
            );
        } else {
            await pool.query(
                `INSERT INTO personnes_objectifs (compte_email, nom, calories, eau, budget, budget_periode, proteines, glucides, lipides, fibres, sucre) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [compteEmail, nom, calories || 0, eau || 0, budget || 0, budget_periode || 'semaine', proteines || 0, glucides || 0, lipides || 0, fibres || 0, sucre || 0]
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
            UPDATE ingredients 
            SET nom = $1, rayon = $2, calories = $3, proteines = $4, glucides = $5, 
                lipides = $6, fibres = $7, sucre = $8, prix = $9, marques = $10 
            WHERE id = $11
        `;
        await pool.query(query, [
            nom, 
            rayon || 'Épicerie', 
            calories || 0, 
            proteines || 0, 
            glucides || 0, 
            lipides || 0, 
            fibres || 0, 
            sucre || 0, 
            prix || 0, 
            marquesStr, 
            id
        ]);
        
        io.emit('data_updated');
        res.json({ success: true, message: "Ingrédient mis à jour avec succès !" });
    } catch (err) {
        console.error("Erreur mise à jour ingrédient :", err);
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
                    SELECT r.parts,
                           COALESCE(r.calories, i.calories) as calories,
                           COALESCE(r.proteines, i.proteines) as proteines,
                           COALESCE(r.glucides, i.glucides) as glucides,
                           COALESCE(r.lipides, i.lipides) as lipides,
                           COALESCE(r.fibres, i.fibres) as fibres,
                           COALESCE(r.sucre, i.sucre) as sucre,
                           COALESCE(r.cout, 0) as cout
                    FROM suivi_conso s
                    LEFT JOIN recettes r ON s.type_element = 'recette' AND s.element_id = r.id
                    LEFT JOIN ingredients i ON s.type_element = 'aliment' AND s.element_id = i.id
                    WHERE s.profil = $1 AND s.jour = $2
                `, [profil, jour]);

                suiviRes.rows.forEach(row => {
                    const ratioPart = 1 / (parseFloat(row.parts) || 1);
                    consomme.calories += (parseFloat(row.calories) || 0) * ratioPart;
                    consomme.proteines += (parseFloat(row.proteines) || 0) * ratioPart;
                    consomme.glucides += (parseFloat(row.glucides) || 0) * ratioPart;
                    consomme.lipides += (parseFloat(row.lipides) || 0) * ratioPart;
                    consomme.fibres += (parseFloat(row.fibres) || 0) * ratioPart;
                    consomme.sucre += (parseFloat(row.sucre) || 0) * ratioPart;
                    consomme.cout += (parseFloat(row.cout) || 0) * ratioPart;
                });
            }
        }

        let categoriesFiltre = [];
        if (categories) {
            categoriesFiltre = Array.isArray(categories) ? categories : categories.split(',').map(c => c.trim().toLowerCase());
        }

        const recettesRes = await pool.query("SELECT * FROM recettes");
        let recettes = recettesRes.rows.map(r => ({
            ...r,
            type: 'recette',
            marques: []
        })).filter(r => {
            const matchNom = r.nom.toLowerCase().includes(termeRecherche);
            const matchCat = categoriesFiltre.length === 0 || (r.categorie && categoriesFiltre.includes(r.categorie.toLowerCase()));
            return matchNom && matchCat;
        });

        const ingredientsRes = await pool.query("SELECT * FROM ingredients");
        let ingredients = ingredientsRes.rows.map(i => ({
            ...i,
            type: 'aliment',
            parts: 1,
            cout: i.prix || 0,
            categorie: i.rayon || 'Épicerie',
            marques: i.marques ? JSON.parse(i.marques) : []
        })).filter(i => {
            const matchNom = i.nom.toLowerCase().includes(termeRecherche);
            const matchCat = categoriesFiltre.length === 0 || (i.rayon && categoriesFiltre.includes(i.rayon.toLowerCase()));
            return matchNom && matchCat;
        });

        let tousLesChoix = [...recettes, ...ingredients];

        tousLesChoix = tousLesChoix.map(item => {
            const parts = parseFloat(item.parts) || 1;
            const ratioPart = 1 / parts;
            const cal = (parseFloat(item.calories) || 0) * ratioPart;
            const pro = (parseFloat(item.proteines) || 0) * ratioPart;
            const glu = (parseFloat(item.glucides) || 0) * ratioPart;
            const lip = (parseFloat(item.lipides) || 0) * ratioPart;
            const fib = (parseFloat(item.fibres) || 0) * ratioPart;
            const suc = (parseFloat(item.sucre) || 0) * ratioPart;
            const cout = (parseFloat(item.cout) || 0) * ratioPart;

            let penalite = 0;

            if ((consomme.calories + cal) > cible.calories) penalite += ((consomme.calories + cal) - cible.calories) * 2;
            if ((consomme.lipides + lip) > cible.lipides) penalite += ((consomme.lipides + lip) - cible.lipides) * 2;
            if ((consomme.glucides + glu) > cible.glucides) penalite += ((consomme.glucides + glu) - cible.glucides) * 1.5;
            if ((consomme.sucre + suc) > cible.sucre) penalite += ((consomme.sucre + suc) - cible.sucre) * 3;
            if ((consomme.cout + cout) > (cible.budget / 7)) penalite += ((consomme.cout + cout) - (cible.budget / 7)) * 5;

            if ((consomme.proteines + pro) < cible.proteines) penalite -= pro * 2.5;
            if ((consomme.fibres + fib) < cible.fibres) penalite -= fib * 2.5;

            const aideProtéinesOuFibres = ((consomme.proteines < cible.proteines && pro >= 10) || (consomme.fibres < cible.fibres && fib >= 3));
            const respecteLimites = (consomme.calories + cal <= cible.calories * 1.1) && (consomme.sucre + suc <= cible.sucre);
            const recommandeEnVert = aideProtéinesOuFibres && respecteLimites;

            return {
                ...item,
                scoreRecommandation: penalite,
                recommandeEnVert: recommandeEnVert
            };
        });

        tousLesChoix.sort((a, b) => {
            if (a.recommandeEnVert && !b.recommandeEnVert) return -1;
            if (!a.recommandeEnVert && b.recommandeEnVert) return 1;
            return a.scoreRecommandation - b.scoreRecommandation;
        });

        res.json(tousLesChoix);
    } catch (err) {
        console.error("Erreur recherche globale :", err);
        res.status(500).json({ error: err.message });
    }
});

// --- CALCUL DE SCORE ---
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

// --- API MENU PRÉVU ---
app.get('/api/menus', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM menu_prevu");
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
    if (!profil || !jour) return res.status(400).json({ error: "Profil ou jour manquant" });
    
    try {
        const menuRes = await pool.query(
            "SELECT petitdejeuner, repas1, repas2, dessertcollation FROM menu_prevu WHERE profil = $1 AND jour = $2", 
            [profil, jour]
        );
        const menu = menuRes.rows[0];
        
        if (!menu) {
            return res.json({ calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 });
        }
        
        const idsRecettes = [menu.petitdejeuner, menu.repas1, menu.repas2, menu.dessertcollation].filter(Boolean);
        
        if (idsRecettes.length === 0) {
            return res.json({ calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 });
        }
        
        const placeholders = idsRecettes.map((_, i) => `$${i + 1}`).join(',');
        const recettesRes = await pool.query(`SELECT parts, calories, proteines, glucides, lipides, fibres, sucre, cout FROM recettes WHERE id IN (${placeholders})`, idsRecettes);
        
        let totaux = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 };
        
        recettesRes.rows.forEach(r => {
            const parts = parseFloat(r.parts) || 1;
            const ratioPart = 1 / parts;
            
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

// --- LOGIQUE COMMUNE POUR LA GÉNÉRATION DE MENU ---
async function traiterGenerationMenu(req, res) {
    const { profil } = req.body;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });

    try {
        // 1. Récupérer les objectifs du profil
        const objRes = await pool.query("SELECT * FROM personnes_objectifs WHERE nom = $1", [profil]);
        let cible = { calories: 2000, proteines: 120, glucides: 200, lipides: 70 };
        if (objRes.rows.length > 0) {
            const obj = objRes.rows[0];
            cible = {
                calories: parseFloat(obj.calories) || 2000,
                proteines: parseFloat(obj.proteines) || 120,
                glucides: parseFloat(obj.glucides) || 200,
                lipides: parseFloat(obj.lipides) || 70
            };
        }

        // 2. Récupérer toutes les recettes disponibles
        const recettesRes = await pool.query("SELECT * FROM recettes");
        const recettes = recettesRes.rows;

        if (recettes.length === 0) {
            return res.status(400).json({ error: "Aucune recette disponible pour générer un menu." });
        }

        const jours = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

        // Fonction utilitaire pour trouver la recette idéale selon une cible de calories par repas
        function trouverMeilleureRecette(catFiltre = null, cibleCalorieRepas = 600) {
            let candidates = recettes;
            if (catFiltre) {
                candidates = recettes.filter(r => r.categorie && r.categorie.toLowerCase() === catFiltre.toLowerCase());
                if (candidates.length === 0) candidates = recettes; // Fallback si la catégorie est vide
            }

            let bestRecette = candidates[0];
            let bestScore = Infinity;

            candidates.forEach(r => {
                const parts = parseFloat(r.parts) || 1;
                const rCal = (parseFloat(r.calories) || 0) / parts;
                const score = Math.abs(rCal - cibleCalorieRepas);
                if (score < bestScore) {
                    bestScore = score;
                    bestRecette = r;
                }
            });
            return bestRecette ? bestRecette.id : null;
        }

        // 3. Boucler sur les 7 jours de la semaine pour insérer ou mettre à jour le planning
        for (const jour of jours) {
            const idPetitDej = trouverMeilleureRecette('Petit-déjeuner', cible.calories * 0.2);
            const idRepas1 = trouverMeilleureRecette('Plat', cible.calories * 0.35);
            const idRepas2 = trouverMeilleureRecette('Plat', cible.calories * 0.35);
            const idDessert = trouverMeilleureRecette('Dessert', cible.calories * 0.1);

            const q = `
                INSERT INTO menu_prevu (profil, jour, petitdejeuner, repas1, repas2, dessertcollation) 
                VALUES ($1, $2, $3, $4, $5, $6) 
                ON CONFLICT (profil, jour) DO UPDATE SET 
                    petitdejeuner = EXCLUDED.petitdejeuner, 
                    repas1 = EXCLUDED.repas1, 
                    repas2 = EXCLUDED.repas2, 
                    dessertcollation = EXCLUDED.dessertcollation
            `;
            await pool.query(q, [profil, jour, idPetitDej, idRepas1, idRepas2, idDessert]);
        }

        io.emit('data_updated');
        res.json({ success: true, message: "Menu de la semaine généré avec succès !" });
    } catch (err) {
        console.error("Erreur génération automatique menu :", err);
        res.status(500).json({ error: err.message });
    }
}
// --- API GET /api/menus-semaine (Avec calculs nutritionnels et budget par jour) ---
app.get('/api/menus-semaine', async (req, res) => {
    let profil = req.query.profil;
    const compteEmail = req.session.user;

    try {
        if (!profil || profil === 'undefined' || profil === 'null' || profil.trim() === '') {
            if (compteEmail) {
                const profilsRes = await pool.query("SELECT nom FROM personnes_objectifs WHERE compte_email = $1 LIMIT 1", [compteEmail]);
                if (profilsRes.rows.length > 0) {
                    profil = profilsRes.rows[0].nom;
                } else {
                    profil = compteEmail;
                }
            } else {
                return res.status(400).json({ error: "Profil manquant et utilisateur non connecté" });
            }
        }

        const result = await pool.query("SELECT * FROM menu_prevu WHERE profil = $1", [profil]);
        
        const semaineObj = {};
        const totauxSemaine = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, budget: 0 };

        for (const row of result.rows) {
            const jour = row.jour;
            const repasJour = {
                'Petit Déjeuner': row.petitdejeuner || '',
                'Repas 1': row.repas1 || '',
                'Repas 2': row.repas2 || '',
                'Dessert/Collation': row.dessertcollation || ''
            };

            // Récupérer tous les noms / IDs des plats du jour pour calculer leurs apports
            const nomsPlats = Object.values(repasJour).filter(Boolean);
            let totauxJour = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, budget: 0 };

            if (nomsPlats.length > 0) {
                // Recherche dans les recettes (par nom)
                const recettesRes = await pool.query(
                    `SELECT parts, calories, proteines, glucides, lipides, fibres, sucre, cout FROM recettes WHERE nom = ANY($1::text[])`, 
                    [nomsPlats]
                );
                
                recettesRes.rows.forEach(r => {
                    const parts = parseFloat(r.parts) || 1;
                    const ratioPart = 1 / parts; // Calcul proportionnel à la part
                    totauxJour.calories += (parseFloat(r.calories) || 0) * ratioPart;
                    totauxJour.proteines += (parseFloat(r.proteines) || 0) * ratioPart;
                    totauxJour.glucides += (parseFloat(r.glucides) || 0) * ratioPart;
                    totauxJour.lipides += (parseFloat(r.lipides) || 0) * ratioPart;
                    totauxJour.fibres += (parseFloat(r.fibres) || 0) * ratioPart;
                    totauxJour.sucre += (parseFloat(r.sucre) || 0) * ratioPart;
                    totauxJour.budget += (parseFloat(r.cout) || 0) * ratioPart;
                });
            }

            // Cumul pour la semaine globale
            totauxSemaine.calories += totauxJour.calories;
            totauxSemaine.proteines += totauxJour.proteines;
            totauxSemaine.glucides += totauxJour.glucides;
            totauxSemaine.lipides += totauxJour.lipides;
            totauxSemaine.fibres += totauxJour.fibres;
            totauxSemaine.sucre += totauxJour.sucre;
            totauxSemaine.budget += totauxJour.budget;

            semaineObj[jour] = {
                repas: repasJour,
                totaux: {
                    calories: Math.round(totauxJour.calories),
                    proteines: Math.round(totauxJour.proteines),
                    glucides: Math.round(totauxJour.glucides),
                    lipides: Math.round(totauxJour.lipides),
                    fibres: Math.round(totauxJour.fibres),
                    sucre: Math.round(totauxJour.sucre),
                    budget: Math.round(totauxJour.budget * 100) / 100
                }
            };
        }

        res.json({ 
            semaine: semaineObj, 
            totauxSemaine: {
                calories: Math.round(totauxSemaine.calories),
                proteines: Math.round(totauxSemaine.proteines),
                glucides: Math.round(totauxSemaine.glucides),
                lipides: Math.round(totauxSemaine.lipides),
                fibres: Math.round(totauxSemaine.fibres),
                sucre: Math.round(totauxSemaine.sucre),
                budget: Math.round(totauxSemaine.budget * 100) / 100
            }
        });
    } catch (err) {
        console.error("ERREUR /api/menus-semaine :", err);
        res.status(500).json({ error: err.message });
    }
});

// --- API GET /api/suivi-conso-semaine ---
app.get('/api/suivi-conso-semaine', async (req, res) => {
    let profil = req.query.profil;
    const compteEmail = req.session.user;

    try {
        if (!profil || profil === 'undefined' || profil === 'null' || profil.trim() === '') {
            if (compteEmail) {
                const profilsRes = await pool.query("SELECT nom FROM personnes_objectifs WHERE compte_email = $1 LIMIT 1", [compteEmail]);
                if (profilsRes.rows.length > 0) {
                    profil = profilsRes.rows[0].nom;
                } else {
                    profil = compteEmail;
                }
            } else {
                return res.status(400).json({ error: "Profil manquant et utilisateur non connecté" });
            }
        }

        const result = await pool.query("SELECT * FROM suivi_conso WHERE profil = $1", [profil]);
        res.json(result.rows || []);
    } catch (err) {
        console.error("ERREUR /api/suivi-conso-semaine :", err);
        res.status(500).json({ error: err.message });
    }
});

// --- API GÉNÉRATION AUTOMATIQUE DE MENU (LES DEUX ROUTES SUPPORTÉES) ---
app.post('/api/generer-menu', traiterGenerationMenu);
app.post('/api/menus-semaine', traiterGenerationMenu);

// --- LANCEMENT DU SERVEUR ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});