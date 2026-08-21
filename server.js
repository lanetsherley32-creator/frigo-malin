const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialisation de la Base de Données SQLite
const dbPath = path.join(__dirname, 'database.sqlite');
const dbInstance = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Erreur ouverture DB", err.message);
    } else {
        console.log("Connecté à la base de données SQLite.");
        createTables();
    }
});

function createTables() {
    dbInstance.serialize(() => {
        // Table Ingrédients
        dbInstance.run(`CREATE TABLE IF NOT EXISTS ingredients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nom TEXT,
            marque TEXT,
            format TEXT,
            unite TEXT,
            rayon TEXT,
            prixLeclerc REAL,
            prixCarrefour REAL,
            prixLidl REAL,
            calories REAL,
            proteines REAL,
            glucides REAL,
            lipides REAL
        )`);

        // Table Recettes avec tous les champs complets
        dbInstance.run(`CREATE TABLE IF NOT EXISTS recettes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nom TEXT,
            categorie TEXT,
            parts INTEGER,
            ingredients TEXT,
            etapes TEXT,
            calories REAL,
            proteines REAL,
            glucides REAL,
            lipides REAL,
            cout REAL
        )`, (err) => {
            if (!err) {
                // Vérifier si des recettes existent déjà, sinon en insérer par défaut
                dbInstance.get("SELECT COUNT(*) as count FROM recettes", (err, row) => {
                    if (row && row.count === 0) {
                        const stmtRec = dbInstance.prepare(`INSERT INTO recettes (nom, categorie, parts, ingredients, etapes, calories, proteines, glucides, lipides, cout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                        stmtRec.run(['Pâtes Bolognaises', 'Plat', 4, 'Pâtes (400g), Tomates (500g)', '1. Cuire les pâtes\n2. Préparer la sauce', 620, 32, 75, 18, 4.5]);
                        stmtRec.run(['Omelette Fromage', 'Plat', 2, 'Œufs (4 pièces), Fromage (100g)', '1. Battre les œufs\n2. Cuire à la poêle', 410, 24, 2, 32, 2.8]);
                        stmtRec.finalize();
                        console.log("✅ Recettes par défaut insérées.");
                    }
                });
            }
        });
    });
}

// --- API Ingrédients ---
app.get('/api/ingredients', (req, res) => {
    dbInstance.all("SELECT * FROM ingredients", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/ingredients', (req, res) => {
    const data = req.body;
    const query = `INSERT INTO ingredients (nom, marque, format, unite, rayon, prixLeclerc, prixCarrefour, prixLidl, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [data.nom, data.marque, data.format, data.unite, data.rayon, data.prixLeclerc, data.prixCarrefour, data.prixLidl, data.calories, data.proteines, data.glucides, data.lipides];
    
    dbInstance.run(query, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ id: this.lastID });
    });
});

app.put('/api/ingredients/:id', (req, res) => {
    const data = req.body;
    const query = `UPDATE ingredients SET nom = ?, marque = ?, format = ?, unite = ?, rayon = ?, prixLeclerc = ?, prixCarrefour = ?, prixLidl = ?, calories = ?, proteines = ?, glucides = ?, lipides = ? WHERE id = ?`;
    const params = [data.nom, data.marque, data.format, data.unite, data.rayon, data.prixLeclerc, data.prixCarrefour, data.prixLidl, data.calories, data.proteines, data.glucides, data.lipides, req.params.id];
    
    dbInstance.run(query, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});

app.delete('/api/ingredients/:id', (req, res) => {
    dbInstance.run("DELETE FROM ingredients WHERE id = ?", req.params.id, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});

// --- API Recettes Complètes ---
app.get('/api/recettes', (req, res) => {
    dbInstance.all("SELECT * FROM recettes", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/recettes', (req, res) => {
    const { nom, categorie, parts, ingredients, etapes, calories, proteines, glucides, lipides, cout } = req.body;
    const query = `INSERT INTO recettes (nom, categorie, parts, ingredients, etapes, calories, proteines, glucides, lipides, cout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    dbInstance.run(query, [nom, categorie, parts, ingredients, etapes, calories, proteines, glucides, lipides, cout], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ id: this.lastID });
    });
});

app.put('/api/recettes/:id', (req, res) => {
    const { nom, categorie, parts, ingredients, etapes, calories, proteines, glucides, lipides, cout } = req.body;
    const query = `UPDATE recettes SET nom = ?, categorie = ?, parts = ?, ingredients = ?, etapes = ?, calories = ?, proteines = ?, glucides = ?, lipides = ?, cout = ? WHERE id = ?`;
    dbInstance.run(query, [nom, categorie, parts, ingredients, etapes, calories, proteines, glucides, lipides, cout, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});

app.delete('/api/recettes/:id', (req, res) => {
    dbInstance.run("DELETE FROM recettes WHERE id = ?", req.params.id, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});

// Recherche Open Food Facts
app.get('/api/recherche-produit', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    try {
        const response = await axios.get(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1`);
        const produits = response.data.products.slice(0, 5).map(p => ({
            nom: p.product_name || 'Inconnu',
            marque: p.brands || '',
            format: p.quantity || '',
            calories: p.nutriments && p.nutriments['energy-kcal_100g'] ? p.nutriments['energy-kcal_100g'] : 0,
            proteines: p.nutriments && p.nutriments['proteins_100g'] ? p.nutriments['proteins_100g'] : 0,
            glucides: p.nutriments && p.nutriments['carbohydrates_100g'] ? p.nutriments['carbohydrates_100g'] : 0,
            lipides: p.nutriments && p.nutriments['fat_100g'] ? p.nutriments['fat_100g'] : 0
        }));
        res.json(produits);
    } catch (e) {
        res.status(500).json({ error: "Erreur Open Food Facts" });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});