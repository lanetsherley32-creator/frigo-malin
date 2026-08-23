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

// --- FICHIERS STATIQUES ---
app.use(express.static('public'));

// --- MIDDLEWARE DE PROTECTION ---
app.use((req, res, next) => {
    const cheminsPublics = [
        '/', '/login.html', '/forgot.html', '/reset.html', 
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

// --- MODIFIER UN INGRÉDIENT (Route ajoutée) ---
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

// --- LOGIQUE COMMUNE POUR LA GÉNÉRATION ALÉATOIRE ---
async function executerGenerationAleatoire(req) {
    let profil = req.body.profil;

    if (!profil && req.session.user) {
        const userProfiles = await pool.query("SELECT nom FROM personnes_objectifs WHERE compte_email = $1 LIMIT 1", [req.session.user]);
        if (userProfiles.rows.length > 0) {
            profil = userProfiles.rows[0].nom;
        }
    }

    if (!profil) {
        throw new Error("Profil manquant");
    }

    const objRes = await pool.query("SELECT * FROM personnes_objectifs WHERE nom = $1", [profil]);
    const obj = objRes.rows[0] || {};
    
    const cibleJour = {
        calories: parseFloat(obj.calories) || 2000,
        proteines: parseFloat(obj.proteines) || 120,
        glucides: parseFloat(obj.glucides) || 200,
        lipides: parseFloat(obj.lipides) || 70,
        fibres: parseFloat(obj.fibres) || 30,
        sucre: parseFloat(obj.sucre) || 50
    };

    const budgetMaxSemaine = parseFloat(obj.budget) || 99999;

    const recettesRes = await pool.query("SELECT * FROM recettes");
    const recettes = recettesRes.rows || [];
    if (recettes.length === 0) throw new Error("Aucune recette disponible.");

    const jours = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    const ratios = [0.20, 0.35, 0.35, 0.10]; 
    const repasKeys = ['petitDejeuner', 'repas1', 'repas2', 'dessertCollation'];

    let meilleureSemaine = null;
    let meilleurScoreGlobal = Infinity;

    for (let essai = 0; essai < 25; essai++) {
        let semaineCourante = {};
        let coutTotalSemaine = 0;
        let ingredientsSemaineQte = {};
        let scoreSemaine = 0;

        for (const jour of jours) {
            let selectionJour = {};
            for (let i = 0; i < repasKeys.length; i++) {
                const ratio = ratios[i];
                const sousCible = {
                    calories: cibleJour.calories * ratio,
                    proteines: cibleJour.proteines * ratio,
                    glucides: cibleJour.glucides * ratio,
                    lipides: cibleJour.lipides * ratio,
                    fibres: cibleJour.fibres * ratio,
                    sucre: cibleJour.sucre * ratio
                };

                const recettesTriees = [...recettes].sort((a, b) => {
                    let scoreA = calculerScoreEcart(a, sousCible);
                    let scoreB = calculerScoreEcart(b, sousCible);

                    try {
                        let ingsA = typeof a.ingredients === 'string' ? JSON.parse(a.ingredients) : a.ingredients;
                        if (Array.isArray(ingsA)) {
                            ingsA.forEach(ing => {
                                let id = ing.id || ing.ingredient_id;
                                if (id && ingredientsSemaineQte[id] && ingredientsSemaineQte[id].reste > 0) {
                                    scoreA -= 15;
                                }
                            });
                        }
                    } catch(e){}

                    try {
                        let ingsB = typeof b.ingredients === 'string' ? JSON.parse(b.ingredients) : b.ingredients;
                        if (Array.isArray(ingsB)) {
                            ingsB.forEach(ing => {
                                let id = ing.id || ing.ingredient_id;
                                if (id && ingredientsSemaineQte[id] && ingredientsSemaineQte[id].reste > 0) {
                                    scoreB -= 15;
                                }
                            });
                        }
                    } catch(e){}

                    return scoreA - scoreB;
                });

                const topChoices = recettesTriees.slice(0, Math.min(4, recettesTriees.length));
                const chosen = topChoices[Math.floor(Math.random() * topChoices.length)] || recettesTriees[0];

                selectionJour[repasKeys[i]] = chosen ? chosen.id : null;
                
                const parts = parseFloat(chosen?.parts) || 1;
                coutTotalSemaine += (parseFloat(chosen?.cout) || 0) / parts;

                try {
                    let ings = typeof chosen.ingredients === 'string' ? JSON.parse(chosen.ingredients) : chosen.ingredients;
                    if (Array.isArray(ings)) {
                        ings.forEach(ing => {
                            let id = ing.id || ing.ingredient_id;
                            let qteUtilisee = parseFloat(ing.quantite) || 0;
                            if (id) {
                                if (!ingredientsSemaineQte[id]) {
                                    ingredientsSemaineQte[id] = { reste: 0 };
                                }
                                ingredientsSemaineQte[id].reste += qteUtilisee;
                                if (ingredientsSemaineQte[id].reste >= 500) {
                                    ingredientsSemaineQte[id].reste = 0;
                                }
                            }
                        });
                    }
                } catch(e){}
            }
            semaineCourante[jour] = selectionJour;
        }

        let penaliteRestes = 0;
        Object.values(ingredientsSemaineQte).forEach(item => {
            if (item.reste > 0) penaliteRestes += item.reste * 0.05;
        });

        let penaliteBudget = coutTotalSemaine > budgetMaxSemaine ? (coutTotalSemaine - budgetMaxSemaine) * 50 : 0;
        scoreSemaine += penaliteBudget + penaliteRestes;

        if (scoreSemaine < meilleurScoreGlobal) {
            meilleurScoreGlobal = scoreSemaine;
            meilleureSemaine = semaineCourante;
        }
    }

    for (const jour of jours) {
        const sel = meilleureSemaine[jour];
        const q = `
            INSERT INTO menu_prevu (profil, jour, petitdejeuner, repas1, repas2, dessertcollation) 
            VALUES ($1, $2, $3, $4, $5, $6) 
            ON CONFLICT (profil, jour) DO UPDATE SET 
                petitdejeuner = EXCLUDED.petitdejeuner, 
                repas1 = EXCLUDED.repas1, 
                repas2 = EXCLUDED.repas2, 
                dessertcollation = EXCLUDED.dessertcollation
        `;
        await pool.query(q, [profil, jour, sel.petitDejeuner, sel.repas1, sel.repas2, sel.dessertCollation]);
    }

    io.emit('data_updated');
}

// --- API ROUTES DE GÉNÉRATION ---
app.post('/api/menu-aleatoire-optimise', async (req, res) => {
    try {
        await executerGenerationAleatoire(req);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/menus/generer-aleatoire', async (req, res) => {
    try {
        await executerGenerationAleatoire(req);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- API RECETTES RECOMMANDÉES ---
app.get('/api/recettes-recommandees-optimisees', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil || !jour) return res.status(400).json({ error: "Profil ou jour manquant" });

    try {
        const objRes = await pool.query("SELECT * FROM personnes_objectifs WHERE nom = $1", [profil]);
        const obj = objRes.rows[0] || {};
        const cible = {
            calories: parseFloat(obj.calories) || 2000,
            proteines: parseFloat(obj.proteines) || 120,
            glucides: parseFloat(obj.glucides) || 200,
            lipides: parseFloat(obj.lipides) || 70,
            fibres: parseFloat(obj.fibres) || 30,
            sucre: parseFloat(obj.sucre) || 50,
            budget: parseFloat(obj.budget) || 100
        };

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

        let consomme = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 };
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

        const recettesRes = await pool.query("SELECT * FROM recettes");
        const recettes = recettesRes.rows || [];

        const recos = recettes.map(r => {
            const parts = parseFloat(r.parts) || 1;
            const ratioPart = 1 / parts;
            const cal = (parseFloat(r.calories) || 0) * ratioPart;
            const pro = (parseFloat(r.proteines) || 0) * ratioPart;
            const glu = (parseFloat(r.glucides) || 0) * ratioPart;
            const lip = (parseFloat(r.lipides) || 0) * ratioPart;
            const fib = (parseFloat(r.fibres) || 0) * ratioPart;
            const suc = (parseFloat(r.sucre) || 0) * ratioPart;
            const cout = (parseFloat(r.cout) || 0) * ratioPart;

            let score = 0;
            if ((consomme.calories + cal) > cible.calories) score += ((consomme.calories + cal) - cible.calories) * 2;
            if ((consomme.sucre + suc) > cible.sucre) score += ((consomme.sucre + suc) - cible.sucre) * 3;
            if ((consomme.lipides + lip) > cible.lipides) score += ((consomme.lipides + lip) - cible.lipides) * 2;
            if ((consomme.glucides + glu) > cible.glucides) score += ((consomme.glucides + glu) - cible.glucides) * 1.5;
            if ((consomme.cout + cout) > (cible.budget / 7)) score += ((consomme.cout + cout) - (cible.budget / 7)) * 5;

            if ((consomme.proteines + pro) < cible.proteines) score -= pro * 1.5;
            if ((consomme.fibres + fib) < cible.fibres) score -= fib * 1.5;

            return { ...r, scoreRecommandation: score };
        });

        recos.sort((a, b) => a.scoreRecommandation - b.scoreRecommandation);
        res.json(recos.slice(0, 10));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API SUIVI ---
app.get('/api/suivi', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM suivi_conso");
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/suivi-conso', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil) return res.json([]);
    try {
        const query = `
            SELECT s.*, 
                   COALESCE(r.nom, i.nom) as nom_element,
                   COALESCE(r.parts, 1) as parts,
                   COALESCE(r.calories, i.calories) as calories,
                   COALESCE(r.proteines, i.proteines) as proteines,
                   COALESCE(r.glucides, i.glucides) as glucides,
                   COALESCE(r.lipides, i.lipides) as lipides,
                   COALESCE(r.fibres, i.fibres) as fibres,
                   COALESCE(r.sucre, i.sucre) as sucre
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
                   COALESCE(r.parts, 1) as parts,
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
            WHERE s.profil = $1
        `;
        const result = await pool.query(query, [profil]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- LANCEMENT DU SERVEUR ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});