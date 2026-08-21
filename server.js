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
app.use(express.static('public')); // Assurez-vous que index.html est dans le dossier 'public'

// --- INITIALISATION BDD ---
db.serialize(() => {
    // Table Profils
    db.run(`CREATE TABLE IF NOT EXISTS profils (
        nom TEXT PRIMARY KEY,
        calories REAL, budget REAL, proteines REAL, glucides REAL, lipides REAL
    )`);

    // Table Recettes
    db.run(`CREATE TABLE IF NOT EXISTS recettes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT, calories REAL, proteines REAL, glucides REAL, lipides REAL, prix REAL
    )`);

    // Table Menus : on stocke tout en TEXT (JSON strings)
    db.run(`CREATE TABLE IF NOT EXISTS menus (
        profil TEXT,
        jour TEXT,
        petitDejeuner TEXT,
        repas1 TEXT,
        repas2 TEXT,
        dessertCollation TEXT,
        grignotage TEXT,
        PRIMARY KEY (profil, jour)
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

// --- API MENU ---
app.get('/api/menu', (req, res) => {
    const { jour, profil } = req.query;
    db.get("SELECT * FROM menus WHERE jour = ? AND profil = ?", [jour, profil], (err, row) => {
        if (!row) {
            res.json({ petitDejeuner: [], repas1: [], repas2: [], dessertCollation: [], grignotage: [] });
        } else {
            // Conversion des chaînes JSON en tableaux
            res.json({
                petitDejeuner: JSON.parse(row.petitDejeuner || '[]'),
                repas1: JSON.parse(row.repas1 || '[]'),
                repas2: JSON.parse(row.repas2 || '[]'),
                dessertCollation: JSON.parse(row.dessertCollation || '[]'),
                grignotage: JSON.parse(row.grignotage || '[]')
            });
        }
    });
});

app.post('/api/menu', (req, res) => {
    const { jour, profil, petitDejeuner, repas1, repas2, dessertCollation, grignotage } = req.body;

    const query = `INSERT INTO menus (profil, jour, petitDejeuner, repas1, repas2, dessertCollation, grignotage) 
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(profil, jour) DO UPDATE SET 
                   petitDejeuner=excluded.petitDejeuner,
                   repas1=excluded.repas1,
                   repas2=excluded.repas2,
                   dessertCollation=excluded.dessertCollation,
                   grignotage=excluded.grignotage`;

    const params = [
        profil, jour,
        JSON.stringify(petitDejeuner || []),
        JSON.stringify(repas1 || []),
        JSON.stringify(repas2 || []),
        JSON.stringify(dessertCollation || []),
        JSON.stringify(grignotage || [])
    ];

    db.run(query, params, (err) => {
        if (err) res.status(500).json({ error: err.message });
        else res.sendStatus(200);
    });
});

server.listen(3000, () => console.log('Serveur démarré sur http://localhost:3000'));