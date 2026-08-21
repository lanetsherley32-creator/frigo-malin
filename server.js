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

// --- INITIALISATION BDD & DONNÉES PAR DÉFAUT ---
db.serialize(() => {
    // 1. Table Profils
    db.run(`CREATE TABLE IF NOT EXISTS profils (
        nom TEXT PRIMARY KEY,
        calories REAL, budget REAL, proteines REAL, glucides REAL, lipides REAL
    )`);

    // 2. Table Recettes (5 recettes créées)
    db.run(`CREATE TABLE IF NOT EXISTS recettes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT, calories REAL, proteines REAL, glucides REAL, lipides REAL, prix REAL
    )`, () => {
        db.get("SELECT COUNT(*) as count FROM recettes", (err, row) => {
            if (row && row.count === 0) {
                const recettesDefaut = [
                    ['Poulet Rôti & Riz Basmati', 550, 45, 60, 10, 4.50],
                    ['Bowl Végétarien Quinoa & Avocat', 450, 15, 50, 20, 3.80],
                    ['Pavé de Saumon & Purée de Patates Douces', 600, 38, 40, 22, 6.20],
                    ['Omelette aux Légumes & Feta', 380, 24, 6, 26, 2.50],
                    ['Porridge Flocons d\'Avoine, Banane & Beurre de Cacahuète', 420, 14, 58, 12, 1.80]
                ];
                const stmt = db.prepare("INSERT INTO recettes (nom, calories, proteines, glucides, lipides, prix) VALUES (?, ?, ?, ?, ?, ?)");
                recettesDefaut.forEach(r => stmt.run(r));
                stmt.finalize();
            }
        });
    });

    // 3. Table Ingrédients (30 ingrédients classés)
    db.run(`CREATE TABLE IF NOT EXISTS ingredients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT, calories REAL, proteines REAL, glucides REAL, lipides REAL, prix REAL
    )`, () => {
        db.get("SELECT COUNT(*) as count FROM ingredients", (err, row) => {
            if (row && row.count === 0) {
                const ingredientsDefaut = [
                    // --- 10 Viandes / Poissons ---
                    ['Blancs de poulet', 120, 23, 0, 2.5, 9.50],
                    ['Steak haché 5% MG', 125, 21, 0, 4.5, 12.00],
                    ['Pavé de saumon', 206, 22, 0, 13, 18.00],
                    ['Escalope de dinde', 110, 24, 0, 1.5, 10.00],
                    ['Filet de cabillaud', 82, 18, 0, 0.7, 15.00],
                    ['Tranches de bacon', 250, 15, 0, 20, 14.00],
                    ['Steak de bœuf', 150, 22, 0, 7, 13.50],
                    ['Cuisses de poulet', 160, 20, 0, 8.5, 6.50],
                    ['Thon en conserve au naturel', 100, 23, 0, 1, 9.00],
                    ['Jambon blanc découenné', 115, 20, 0, 3.5, 11.00],

                    // --- 5 Épicerie Salée ---
                    ['Riz basmati', 350, 7, 75, 1, 2.20],
                    ['Pâtes complètes', 340, 13, 65, 2, 1.90],
                    ['Quinoa', 368, 14, 64, 6, 4.50],
                    ['Huile d\'olive', 900, 0, 0, 100, 8.00],
                    ['Flocons d\'avoine', 389, 16.9, 66.3, 6.9, 1.80],

                    // --- 5 Épicerie Sucrée ---
                    ['Miel', 304, 0.3, 82, 0, 7.50],
                    ['Chocolat noir 70%', 580, 8, 30, 43, 11.00],
                    ['Beurre de cacahuète', 590, 25, 20, 50, 9.00],
                    ['Compote de pommes sans sucres ajoutés', 50, 0.4, 12, 0.2, 3.00],
                    ['Sucre de canne', 387, 0, 100, 0, 2.00],

                    // --- 5 Fruits ---
                    ['Banane', 89, 1.1, 23, 0.3, 2.50],
                    ['Pomme', 52, 0.3, 14, 0.2, 2.80],
                    ['Fraises', 32, 0.7, 7.7, 0.3, 6.00],
                    ['Avocat', 160, 2, 9, 15, 5.50],
                    ['Citron', 29, 1.1, 9, 0.3, 3.20],

                    // --- 5 Légumes ---
                    ['Brocoli', 34, 2.8, 7, 0.4, 3.00],
                    ['Épinards frais', 23, 2.9, 3.6, 0.4, 4.00],
                    ['Tomate', 18, 0.9, 3.9, 0.2, 2.50],
                    ['Courgette', 17, 1.2, 3.1, 0.3, 2.20],
                    ['Patate douce', 86, 1.6, 20, 0.1, 3.50]
                ];

                const stmt = db.prepare("INSERT INTO ingredients (nom, calories, proteines, glucides, lipides, prix) VALUES (?, ?, ?, ?, ?, ?)");
                ingredientsDefaut.forEach(i => stmt.run(i));
                stmt.finalize();
            }
        });
    });

    // 4. Tables de gestion des menus et du suivi
    db.run(`CREATE TABLE IF NOT EXISTS menu_prevu (
        profil TEXT,
        jour TEXT,
        petitDejeuner TEXT,
        repas1 TEXT,
        repas2 TEXT,
        dessertCollation TEXT,
        PRIMARY KEY (profil, jour)
    )`);

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

// --- API INGREDIENTS ---
app.get('/api/ingredients', (req, res) => {
    db.all("SELECT * FROM ingredients", [], (err, rows) => res.json(rows));
});

// --- API PROFILS ---
app.get('/api/profils', (req, res) => {
    db.all("SELECT * FROM profils", [], (err, rows) => res.json(rows));
});

app.post('/api/profils', (req, res) => {
    const { ancienNom, nom, calories, budget, proteines, glucides, lipides } = req.body;

    if (ancienNom && ancienNom !== nom) {
        db.get("SELECT * FROM profils WHERE nom = ?", [nom], (err, row) => {
            if (row) {
                return res.status(400).json({ error: "Ce pseudo existe déjà !" });
            }
            executerSauvegardeProfil();
        });
    } else {
        executerSauvegardeProfil();
    }

    function executerSauvegardeProfil() {
        if (ancienNom && ancienNom !== nom) {
            db.run("DELETE FROM profils WHERE nom = ?", [ancienNom]);
        }

        db.run(`INSERT OR REPLACE INTO profils (nom, calories, budget, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?, ?)`, 
        [nom, calories, budget, proteines, glucides, lipides], (err) => {
            if (err) res.status(500).json({ error: err.message });
            else {
                io.emit('data_updated');
                res.json({ success: true, nom });
            }
        });
    }
});

app.delete('/api/profils/:nom', (req, res) => {
    const nom = req.params.nom;
    db.serialize(() => {
        db.run("DELETE FROM profils WHERE nom = ?", [nom]);
        db.run("DELETE FROM menu_prevu WHERE profil = ?", [nom]);
        db.run("DELETE FROM suivi_consomme WHERE profil = ?", [nom], (err) => {
            if (err) res.status(500).json({ error: err.message });
            else {
                io.emit('data_updated');
                res.sendStatus(200);
            }
        });
    });
});

// --- API MENU PRÉVU ---
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

// --- API SUIVI CONSOMMÉ ---
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