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

// --- API INGREDIENTS (Structure Relationnelle 4 Tables) ---

app.get('/api/ingredients', async (req, res) => {
    try {
        // 1. Récupérer tous les ingrédients
        const ingResult = await pool.query("SELECT * FROM ingredients ORDER BY id DESC");
        const ingredients = ingResult.rows;

        // 2. Pour chaque ingrédient, récupérer ses marques, formats et prix
        const ingredientsComplets = [];
        for (const ing of ingredients) {
            const marquesResult = await pool.query("SELECT * FROM marques WHERE ingredient_id = $1", [ing.id]);
            const marques = [];

            for (const marq of marquesResult.rows) {
                const formatsResult = await pool.query("SELECT * FROM formats WHERE marque_id = $1", [marq.id]);
                const formats = [];

                for (const fmt of formatsResult.rows) {
                    const prixResult = await pool.query("SELECT * FROM prix_enseignes WHERE format_id = $1", [fmt.id]);
                    const prix_enseignes = {};
                    prixResult.rows.forEach(p => {
                        prix_enseignes[p.enseigne] = p.prix;
                    });

                    formats.push({
                        id: fmt.id,
                        qte: fmt.quantite,
                        unite: fmt.unite,
                        prix_enseignes: prix_enseignes
                    });
                }

                marques.push({
                    id: marq.id,
                    nom: marq.nom_marque,
                    calories: marq.calories_kcal,
                    proteines: marq.proteines_g,
                    glucides: marq.glucides_g,
                    sucres: marq.sucres_g,
                    lipides: marq.lipides_g,
                    fibres: marq.fibres_g,
                    formats: formats
                });
            }

            ingredientsComplets.push({
                id: ing.id,
                titre: ing.titre,
                nom: ing.nom_reference, // Mappe nom_reference vers nom pour le front-end
                rayon: ing.rayon,
                portion_quantite: ing.portion_quantite,
                portion_unite: ing.portion_unite,
                marques: marques
            });
        }

        res.json(ingredientsComplets);
    } catch (err) {
        console.error("Erreur GET /api/ingredients:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ingredients', async (req, res) => {
    const { nom, rayon, marques } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Début de la transaction sécurisée

        // 1. Insertion dans ingredients (on met nom et titre identiques par défaut)
        const ingQuery = `
            INSERT INTO ingredients (titre, nom_reference, rayon) 
            VALUES ($1, $2, $3) RETURNING id
        `;
        const ingRes = await client.query(ingQuery, [nom || 'Sans nom', nom || 'Sans nom', rayon || 'Épicerie']);
        const ingredientId = ingRes.rows[0].id;

        // 2. Insertion des marques, formats et prix
        if (Array.isArray(marques)) {
            for (const m of marques) {
                const marqQuery = `
                    INSERT INTO marques (ingredient_id, nom_marque, calories_kcal, proteines_g, glucides_g, sucres_g, lipides_g, fibres_g)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
                `;
                const marqRes = await client.query(marqQuery, [
                    ingredientId,
                    m.nom || 'Générique',
                    m.calories || 0,
                    m.proteines || 0,
                    m.glucides || 0,
                    m.sucres || 0,
                    m.lipides || 0,
                    m.fibres || 0
                ]);
                const marqueId = marqRes.rows[0].id;

                // Mise à jour optionnelle de la portion standard sur l'ingrédient si présente dans la première marque
                if (m.quantite_portion) {
                    await client.query(
                        "UPDATE ingredients SET portion_quantite = $1, portion_unite = $2 WHERE id = $3",
                        [m.quantite_portion, m.unite_portion || 'g', ingredientId]
                    );
                }

                if (Array.isArray(m.formats)) {
                    for (const f of m.formats) {
                        const fmtQuery = `
                            INSERT INTO formats (marque_id, quantite, unite)
                            VALUES ($1, $2, $3) RETURNING id
                        `;
                        const fmtRes = await client.query(fmtQuery, [
                            marqueId,
                            f.qte || 1,
                            f.unite || 'g'
                        ]);
                        const formatId = fmtRes.rows[0].id;

                        if (f.prix_enseignes && typeof f.prix_enseignes === 'object') {
                            for (const [enseigne, prix] of Object.entries(f.prix_enseignes)) {
                                if (enseigne && !isNaN(prix)) {
                                    await client.query(
                                        "INSERT INTO prix_enseignes (format_id, enseigne, prix) VALUES ($1, $2, $3)",
                                        [formatId, enseigne, prix]
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        await client.query('COMMIT'); // Validation de la transaction
        io.emit('data_updated');
        res.json({ success: true, id: ingredientId });
    } catch (err) {
        await client.query('ROLLBACK'); // Annulation en cas d'erreur
        console.error("Erreur POST /api/ingredients:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.put('/api/ingredients/:id', async (req, res) => {
    const { id } = req.params;
    const { nom, rayon, marques } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Mettre à jour l'ingrédient de base
        const updateIngQuery = `
            UPDATE ingredients 
            SET titre = $1, nom_reference = $2, rayon = $3 
            WHERE id = $4
        `;
        await client.query(updateIngQuery, [nom || 'Sans nom', nom || 'Sans nom', rayon || 'Épicerie', id]);

        // 2. Pour une mise à jour propre, on supprime les anciennes marques liées (les cascades supprimeront formats et prix automatiquement)
        await client.query("DELETE FROM marques WHERE ingredient_id = $1", [id]);

        // 3. On réinsère les nouvelles marques reçues du formulaire
        if (Array.isArray(marques)) {
            for (const m of marques) {
                const marqQuery = `
                    INSERT INTO marques (ingredient_id, nom_marque, calories_kcal, proteines_g, glucides_g, sucres_g, lipides_g, fibres_g)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
                `;
                const marqRes = await client.query(marqQuery, [
                    id,
                    m.nom || 'Générique',
                    m.calories || 0,
                    m.proteines || 0,
                    m.glucides || 0,
                    m.sucres || 0,
                    m.lipides || 0,
                    m.fibres || 0
                ]);
                const marqueId = marqRes.rows[0].id;

                if (m.quantite_portion) {
                    await client.query(
                        "UPDATE ingredients SET portion_quantite = $1, portion_unite = $2 WHERE id = $3",
                        [m.quantite_portion, m.unite_portion || 'g', id]
                    );
                }

                if (Array.isArray(m.formats)) {
                    for (const f of m.formats) {
                        const fmtQuery = `
                            INSERT INTO formats (marque_id, quantite, unite)
                            VALUES ($1, $2, $3) RETURNING id
                        `;
                        const fmtRes = await client.query(fmtQuery, [
                            marqueId,
                            f.qte || 1,
                            f.unite || 'g'
                        ]);
                        const formatId = fmtRes.rows[0].id;

                        if (f.prix_enseignes && typeof f.prix_enseignes === 'object') {
                            for (const [enseigne, prix] of Object.entries(f.prix_enseignes)) {
                                if (enseigne && !isNaN(prix)) {
                                    await client.query(
                                        "INSERT INTO prix_enseignes (format_id, enseigne, prix) VALUES ($1, $2, $3)",
                                        [formatId, enseigne, prix]
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        await client.query('COMMIT');
        io.emit('data_updated');
        res.json({ success: true, message: "Ingrédient mis à jour avec succès !" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Erreur PUT /api/ingredients:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/ingredients/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Grâce aux "ON DELETE CASCADE" dans vos tables SQL, supprimer l'ingrédient 
        // va automatiquement supprimer ses marques, formats et prix associés !
        await pool.query("DELETE FROM ingredients WHERE id = $1", [id]);
        io.emit('data_updated');
        res.json({ success: true, message: "Ingrédient supprimé" });
    } catch (err) {
        console.error("Erreur DELETE /api/ingredients:", err.message);
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

app.post('/api/menu-prevu-semaine', async (req, res) => {
    const { profil, jour, petitdejeuner, repas1, repas2, encas, ingredients_repas1, ingredients_repas2, ingredients_petitdejeuner } = req.body;
    if (!profil || !jour) return res.status(400).json({ error: "Profil ou jour manquant" });

    const tableauEncas = Array.isArray(encas) ? encas : (encas ? [encas] : []);
    const tabIngRepas1 = Array.isArray(ingredients_repas1) ? ingredients_repas1 : (ingredients_repas1 ? [ingredients_repas1] : []);
    const tabIngRepas2 = Array.isArray(ingredients_repas2) ? ingredients_repas2 : (ingredients_repas2 ? [ingredients_repas2] : []);
    const tabIngPtDej = Array.isArray(ingredients_petitdejeuner) ? ingredients_petitdejeuner : (ingredients_petitdejeuner ? [ingredients_petitdejeuner] : []);

    const q = `
        INSERT INTO menu_prevu (profil, jour, petitdejeuner, repas1, repas2, encas, ingredients_repas1, ingredients_repas2, ingredients_petitdejeuner) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
        ON CONFLICT (profil, jour) DO UPDATE SET 
            petitdejeuner = EXCLUDED.petitdejeuner, 
            repas1 = EXCLUDED.repas1, 
            repas2 = EXCLUDED.repas2, 
            encas = EXCLUDED.encas,
            ingredients_repas1 = EXCLUDED.ingredients_repas1,
            ingredients_repas2 = EXCLUDED.ingredients_repas2,
            ingredients_petitdejeuner = EXCLUDED.ingredients_petitdejeuner
    `;
    try {
        await pool.query(q, [
            profil, jour, 
            petitdejeuner || null, 
            repas1 || null, 
            repas2 || null, 
            tableauEncas,
            tabIngRepas1,
            tabIngRepas2,
            tabIngPtDej
        ]);
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        console.error("Erreur POST /api/menu-prevu-semaine :", err.message);
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
// --- API FAVORIS ---
app.get('/api/favoris', async (req, res) => {
    const compteEmail = req.session.user;
    const profil = req.query.profil;
    
    if (!compteEmail) return res.status(401).json({ error: "Non connecté" });
    if (!profil) return res.status(400).json({ error: "Profil manquant" });

    try {
        const result = await pool.query(
            "SELECT favoris_data FROM favoris WHERE compte_email = $1 AND profil = $2",
            [compteEmail, profil]
        );

        if (result.rows.length > 0) {
            res.json(result.rows[0].favoris_data);
        } else {
            // Retourne une structure vide par défaut si aucun favori n'est encore enregistré
            res.json({ recettes: [], ingredients: [] });
        }
    } catch (err) {
        console.error("Erreur GET /api/favoris:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/favoris', async (req, res) => {
    const compteEmail = req.session.user;
    const { profil, favoris } = req.body;

    if (!compteEmail) return res.status(401).json({ error: "Non connecté" });
    if (!profil || !favoris) return res.status(400).json({ error: "Données incomplètes" });

    try {
        const query = `
            INSERT INTO favoris (compte_email, profil, favoris_data) 
            VALUES ($1, $2, $3)
            ON CONFLICT (compte_email, profil) 
            DO UPDATE SET favoris_data = EXCLUDED.favoris_data
        `;
        
        await pool.query(query, [compteEmail, profil, JSON.stringify(favoris)]);
        io.emit('data_updated');
        res.json({ success: true, message: "Favoris mis à jour avec succès !" });
    } catch (err) {
        console.error("Erreur POST /api/favoris:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// --- API LISTE DE COURSES ---

// 1. Récupérer la liste des courses
app.get('/api/courses', async (req, res) => {
    const { profil, enseigne, inclureDeja } = req.query;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });

    try {
        let query = "SELECT * FROM courses WHERE profil = $1";
        let params = [profil];

        if (enseigne && enseigne !== 'toutes' && enseigne !== 'meilleur_prix') {
            query += " AND enseigne = $2";
            params.push(enseigne);
        }

        const result = await pool.query(query, params);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/// 2. Générer la liste de courses à partir du menu prévu (avec prix au paquet / marque la moins chère)
app.post('/api/courses/generer', async (req, res) => {
    const { profil } = req.body;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });

    try {
        // Récupérer le menu prévu pour ce profil
        const menuRes = await pool.query("SELECT petitdejeuner, repas1, repas2, dessertcollation FROM menu_prevu WHERE profil = $1", [profil]);
        
        let idsRecettes = [];
        menuRes.rows.forEach(row => {
            if (row.petitdejeuner) idsRecettes.push(row.petitdejeuner);
            if (row.repas1) idsRecettes.push(row.repas1);
            if (row.repas2) idsRecettes.push(row.repas2);
            if (row.dessertcollation) idsRecettes.push(row.dessertcollation);
        });

        if (idsRecettes.length === 0) {
            return res.json({ success: true, message: "Aucun menu planifié trouvé pour générer les courses." });
        }

        // Récupérer les ingrédients des recettes sélectionnées
        const placeholders = idsRecettes.map((_, i) => `$${i + 1}`).join(',');
        const recettesRes = await pool.query(`SELECT ingredients FROM recettes WHERE id IN (${placeholders})`, idsRecettes);

        // Nettoyer l'ancienne liste de courses du profil avant de régénérer
        await pool.query("DELETE FROM courses WHERE profil = $1", [profil]);

        // Pour chaque recette, extraire ses ingrédients et les insérer dans la table courses
        for (const recette of recettesRes.rows) {
            let ingredientsList = [];
            try {
                ingredientsList = typeof recette.ingredients === 'string' ? JSON.parse(recette.ingredients) : recette.ingredients;
            } catch (e) {
                ingredientsList = [];
            }

            if (Array.isArray(ingredientsList)) {
                for (const ingItem of ingredientsList) {
                    const nomIng = ingItem.nom || ingItem.ingredient || 'Ingrédient';
                    
                    // Sécurisation stricte de la quantité pour qu'elle soit toujours un nombre (numeric)
                    let qteNum = parseFloat(ingItem.quantite);
                    const qte = isNaN(qteNum) ? 1.0 : qteNum;
                    
                    const unite = ingItem.unite || '';
                    
                    // Chercher l'ingrédient de référence pour récupérer son vrai rayon et ses marques/prix disponibles
                    const refIngRes = await pool.query("SELECT * FROM ingredients WHERE LOWER(nom) = LOWER($1)", [nomIng]);
                    let marquesDispos = [];
                    let prixRetenu = parseFloat(ingItem.prix || 0);
                    let marqueRetenue = 'Standard';
                    let rayonFinal = ingItem.rayon || 'Épicerie'; // Valeur par défaut initiale

                    if (refIngRes.rows.length > 0) {
                        const ref = refIngRes.rows[0];
                        
                        // Récupération prioritaire du vrai rayon depuis la table des ingrédients
                        if (ref.rayon) {
                            rayonFinal = ref.rayon;
                        }

                        try {
                            marquesDispos = typeof ref.marques === 'string' ? JSON.parse(ref.marques) : (ref.marques || []);
                        } catch (e) { marquesDispos = []; }

                        // Sélectionner par défaut la marque la moins chère si disponible
                        if (Array.isArray(marquesDispos) && marquesDispos.length > 0) {
                            marquesDispos.sort((a, b) => parseFloat(a.prix) - parseFloat(b.prix));
                            prixRetenu = parseFloat(marquesDispos[0].prix) || 0;
                            marqueRetenue = marquesDispos[0].nom || 'Standard';
                        } else if (ref.prix) {
                            prixRetenu = parseFloat(ref.prix) || 0;
                        }
                    }

                    // Insertion sécurisée avec des types explicites
                    await pool.query(
                        `INSERT INTO courses (profil, nom, quantite_necessaire, unite, rayon, prix, marque, marques_disponibles, coche) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                        [
                            profil,                               // $1: text
                            nomIng,                               // $2: text
                            qte,                                  // $3: numeric
                            unite,                                // $4: text
                            rayonFinal,                           // $5: text
                            prixRetenu,                           // $6: numeric
                            marqueRetenue,                        // $7: text
                            JSON.stringify(marquesDispos),        // $8: jsonb
                            0                                     // $9: integer (coche)
                        ]
                    );
                }
            }
        }

        io.emit('data_updated');
        res.json({ success: true, message: "Liste de courses générée avec succès !" });
    } catch (err) {
        console.error("Erreur génération courses :", err);
        res.status(500).json({ error: err.message });
    }
});
// 3. Cocher / décocher un article
app.post('/api/courses/cocher', async (req, res) => {
    const { id, coche } = req.body;
    if (id === undefined || coche === undefined) return res.status(400).json({ error: "Données manquantes" });

    try {
        await pool.query("UPDATE courses SET coche = $1 WHERE id = $2", [coche, id]);
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// 4. Modifier la marque et le prix d'un article de la liste de courses
app.post('/api/courses/changer-marque', async (req, res) => {
    const { id, marque, prix, format_paquet } = req.body;
    if (id === undefined || !marque || prix === undefined) {
        return res.status(400).json({ error: "Données manquantes pour le changement de marque" });
    }

    try {
        await pool.query(
            "UPDATE courses SET marque = $1, prix = $2, format_paquet = $3 WHERE id = $4", 
            [marque, prix, format_paquet || 1, id]
        );
        io.emit('data_updated');
        res.json({ success: true });
    } catch (err) {
        console.error("Erreur changer-marque :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 5. Vider la liste de courses
app.delete('/api/courses', async (req, res) => {
    const { profil } = req.query;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });

    try {
        await pool.query("DELETE FROM courses WHERE profil = $1", [profil]);
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