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
        // Table Ingrédients + Insertion automatique des 30 ingrédients de base
        dbInstance.run(`CREATE TABLE IF NOT EXISTS ingredients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nom TEXT, marque TEXT, format TEXT, unite TEXT, rayon TEXT,
            prixLeclerc REAL, prixCarrefour REAL, prixLidl REAL,
            calories REAL, proteines REAL, glucides REAL, lipides REAL
        )`, (err) => {
            if (!err) {
                dbInstance.get("SELECT COUNT(*) as count FROM ingredients", (err, row) => {
                    if (row && row.count === 0) {
                        const ingredientsInitiaux = [
                            // Viandes & Poissons (10)
                            ["Blancs de Poulet", "", "500g", "g", "Frais", 1.15, 1.25, 1.10, 110, 23.0, 0.0, 1.2],
                            ["Steak Haché 5%", "", "400g", "g", "Frais", 1.40, 1.50, 1.35, 125, 21.0, 0.0, 4.5],
                            ["Pavé de Saumon", "", "300g", "g", "Frais", 2.20, 2.40, 2.10, 208, 20.0, 0.0, 13.5],
                            ["Jambon Blanc", "", "4 tranches", "g", "Frais", 1.05, 1.15, 1.00, 115, 20.0, 0.5, 3.5],
                            ["Escalope de Dinde", "", "400g", "g", "Frais", 1.20, 1.30, 1.15, 105, 24.0, 0.0, 1.0],
                            ["Steak Haché 15%", "", "400g", "g", "Frais", 1.10, 1.20, 1.05, 215, 19.0, 0.0, 15.0],
                            ["Merguez Pur Bœuf", "", "300g", "g", "Frais", 1.30, 1.40, 1.25, 280, 15.0, 1.0, 24.0],
                            ["Lardons Fumé", "", "200g", "g", "Frais", 0.85, 0.95, 0.80, 265, 14.0, 0.5, 23.0],
                            ["Filet de Colin", "", "400g", "g", "Surgelés", 0.90, 0.95, 0.85, 82, 17.5, 0.0, 0.8],
                            ["Chorizo Doux", "", "200g", "g", "Frais", 1.50, 1.60, 1.40, 415, 22.0, 1.5, 35.0],

                            // Légumes & Fruits (10)
                            ["Tomates", "", "Vrac", "g", "Fruits et Légumes", 0.25, 0.29, 0.22, 18, 0.9, 3.5, 0.2],
                            ["Oignons Jaunes", "", "Filet 1kg", "g", "Fruits et Légumes", 0.15, 0.18, 0.12, 40, 1.1, 7.5, 0.1],
                            ["Courgettes", "", "Vrac", "g", "Fruits et Légumes", 0.30, 0.35, 0.28, 17, 1.2, 2.1, 0.3],
                            ["Carottes", "", "Sachet 1kg", "g", "Fruits et Légumes", 0.12, 0.14, 0.10, 35, 0.8, 6.5, 0.2],
                            ["Poivrons Rouges", "", "Vrac", "g", "Fruits et Légumes", 0.45, 0.49, 0.40, 25, 1.0, 4.6, 0.3],
                            ["Salade (Laitue)", "", "Pièce", "pièce", "Fruits et Légumes", 0.80, 0.85, 0.75, 15, 1.4, 1.5, 0.2],
                            ["Brocoli", "", "500g", "g", "Fruits et Légumes", 0.35, 0.39, 0.30, 34, 2.8, 3.0, 0.4],
                            ["Champignons de Paris", "", "Barquette 250g", "g", "Fruits et Légumes", 0.60, 0.65, 0.55, 22, 2.5, 0.5, 0.3],
                            ["Pommes de Terre", "", "Filet 2.5kg", "g", "Fruits et Légumes", 0.20, 0.22, 0.18, 77, 2.0, 17.0, 0.1],
                            ["Aulx (Gousse)", "", "Filet", "g", "Fruits et Légumes", 0.70, 0.75, 0.65, 149, 6.4, 27.5, 0.5],

                            // Épicerie & Féculents (10)
                            ["Riz Blanc", "", "1kg", "g", "Épicerie", 0.20, 0.22, 0.18, 130, 2.7, 28.0, 0.3],
                            ["Pâtes (Spaghetti)", "", "500g", "g", "Épicerie", 0.25, 0.28, 0.23, 355, 12.0, 72.0, 1.5],
                            ["Huile d'Olive", "", "1L", "ml", "Épicerie", 0.80, 0.85, 0.75, 900, 0.0, 0.0, 100.0],
                            ["Concentré de Tomates", "", "Boite 140g", "g", "Épicerie", 0.50, 0.55, 0.45, 82, 4.3, 14.0, 0.5],
                            ["Sel Blanc", "", "1kg", "g", "Épicerie", 0.05, 0.06, 0.04, 0, 0.0, 0.0, 0.0],
                            ["Poivre Noir", "", "50g", "g", "Épicerie", 2.50, 2.70, 2.40, 251, 10.4, 38.6, 3.3],
                            ["Farine de Blé (T55)", "", "1kg", "g", "Épicerie", 0.10, 0.12, 0.09, 364, 10.0, 76.0, 1.0],
                            ["Sucre Blanc", "", "1kg", "g", "Épicerie", 0.11, 0.13, 0.10, 400, 0.0, 100.0, 0.0],
                            ["Lait Demi-Écrémé", "", "1L", "ml", "Frais", 0.10, 0.11, 0.09, 47, 3.2, 4.8, 1.5],
                            ["Crème Fraîche 30%", "", "20cl", "g", "Frais", 0.75, 0.80, 0.70, 290, 2.2, 2.5, 30.0]
                        ];

                        const stmtIng = dbInstance.prepare(`INSERT INTO ingredients (nom, marque, format, unite, rayon, prixLeclerc, prixCarrefour, prixLidl, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                        ingredientsInitiaux.forEach(ing => stmtIng.run(ing));
                        stmtIng.finalize();
                        console.log("✅ 30 ingrédients par défaut insérés.");
                    }
                });
            }
        });

        // Table Recettes
        dbInstance.run(`CREATE TABLE IF NOT EXISTS recettes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nom TEXT, categorie TEXT, parts INTEGER, ingredients TEXT, etapes TEXT,
            calories REAL, proteines REAL, glucides REAL, lipides REAL, cout REAL
        )`, (err) => {
            if (!err) {
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