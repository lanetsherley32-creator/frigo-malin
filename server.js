const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const db = new sqlite3.Database('./database.sqlite');

app.use(bodyParser.json());
app.use(express.static('public'));

// --- INITIALISATION BDD ---
db.serialize(() => {
    // Table Profils
    db.run(`CREATE TABLE IF NOT EXISTS profils (
        nom TEXT PRIMARY KEY,
        calories REAL, budget REAL, proteines REAL, glucides REAL, lipides REAL
    )`);

    // Table Recettes (préservée si elle existe déjà)
    db.run(`CREATE TABLE IF NOT EXISTS recettes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT, calories REAL, proteines REAL, glucides REAL, lipides REAL, prix REAL
    )`);

    // Table Menu Prévu : 1 seul choix par catégorie (pour PDF et Courses)
    db.run(`CREATE TABLE IF NOT EXISTS menu_prevu (
        profil TEXT,
        jour TEXT,
        petitDejeuner TEXT,
        repas1 TEXT,
        repas2 TEXT,
        dessertCollation TEXT,
        PRIMARY KEY (profil, jour)
    )`);

    // Table Suivi Consommé : Permet d'ajouter plusieurs éléments avec une quantité réelle (pour Bilan Nutri)
    db.run(`CREATE TABLE IF NOT EXISTS suivi_consomme (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profil TEXT,
        jour TEXT,
        categorie TEXT,
        recette_id INTEGER,
        quantite REAL
    )`);
});

// --- API RECETTES ---
app.get('/api/recettes', (req, res) => {
    db.all("SELECT * FROM recettes", [], (err, rows) => res.json(rows));
});

// --- API PROFILS ---
app.get('/api/profils', (req, res) => {
    db.all("SELECT * FROM profils", [], (err, rows) => res.json(rows));
});

app.post('/api/profils', (req, res) => {
    const { nom, calories, budget, proteines, glucides, lipides } = req.body;
    db.run(`INSERT OR REPLACE INTO profils VALUES (?, ?, ?, ?, ?, ?)`, 
    [nom, calories, budget, proteines, glucides, lipides], (err) => {
        if (err) res.status(500).json({ error: err.message });
        else {
            io.emit('data_updated');
            res.sendStatus(200);
        }
    });
});

// --- API MENU PRÉVU (Pour PDF et Courses) ---
app.get('/api/menu-prevu', (req, res) => {
    const { jour, profil } = req.query;
    db.get("SELECT * FROM menu_prevu WHERE jour = ? AND profil = ?", [jour, profil], (err, row) => {
        if (!row) {
            res.json({ petitDejeuner: '', repas1: '', repas2: '', dessertCollation: '' });
        } else {
            res.json({
                petitDejeuner: row.petitDejeuner || '',
                repas1: row.repas1 || '',
                repas2: row.repas2 || '',
                dessertCollation: row.dessertCollation || ''
            });
        }
    });
});

app.post('/api/menu-prevu', (req, res) => {
    const { jour, profil, petitDejeuner, repas1, repas2, dessertCollation } = req.body;

    const query = `INSERT INTO menu_prevu (profil, jour, petitDejeuner, repas1, repas2, dessertCollation) 
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(profil, jour) DO UPDATE SET 
                   petitDejeuner=excluded.petitDejeuner,
                   repas1=excluded.repas1,
                   repas2=excluded.repas2,
                   dessertCollation=excluded.dessertCollation`;

    db.run(query, [profil, jour, petitDejeuner || '', repas1 || '', repas2 || '', dessertCollation || ''], (err) => {
        if (err) res.status(500).json({ error: err.message });
        else {
            io.emit('data_updated');
            res.sendStatus(200);
        }
    });
});

// --- API SUIVI CONSOMMÉ (Pour le Bilan Nutritionnel avec Quantités) ---
app.get('/api/suivi-consomme', (req, res) => {
    const { jour, profil } = req.query;
    db.all("SELECT * FROM suivi_consomme WHERE jour = ? AND profil = ?", [jour, profil], (err, rows) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json(rows || []);
    });
});

app.post('/api/suivi-consomme', (req, res) => {
    const { profil, jour, categorie, recette_id, quantite } = req.body;
    db.run(`INSERT INTO suivi_consomme (profil, jour, categorie, recette_id, quantite) VALUES (?, ?, ?, ?, ?)`,
    [profil, jour, categorie, recette_id, quantite || 1], (err) => {
        if (err) res.status(500).json({ error: err.message });
        else {
            io.emit('data_updated');
            res.sendStatus(200);
        }
    });
});

app.delete('/api/suivi-consomme/:id', (req, res) => {
    db.run("DELETE FROM suivi_consomme WHERE id = ?", [req.params.id], (err) => {
        if (err) res.status(500).json({ error: err.message });
        else {
            io.emit('data_updated');
            res.sendStatus(200);
        }
    });
});

server.listen(3000, () => console.log('Serveur démarré sur http://localhost:3000'));