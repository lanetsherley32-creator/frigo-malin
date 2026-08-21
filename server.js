const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database(path.resolve(__dirname, 'database.sqlite'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS ingredients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT,
        variete TEXT,
        rayon TEXT,
        unite TEXT,
        calories REAL DEFAULT 0,
        proteines REAL DEFAULT 0,
        glucides REAL DEFAULT 0,
        lipides REAL DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ingredient_prix (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingredient_id INTEGER,
        supermarche TEXT,
        marque TEXT,
        prix REAL,
        conditionnement_quantite REAL,
        conditionnement_unite TEXT,
        FOREIGN KEY(ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS profils (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT UNIQUE,
        calories_cible REAL,
        proteines_cible REAL,
        glucides_cible REAL,
        lipides_cible REAL,
        budget_semaine REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS recettes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT UNIQUE,
        description TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS recette_ingredients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recette_id INTEGER,
        ingredient_id INTEGER,
        quantite REAL,
        FOREIGN KEY(recette_id) REFERENCES recettes(id) ON DELETE CASCADE,
        FOREIGN KEY(ingredient_id) REFERENCES ingredients(id)
    )`);
});

// --- ROUTES INGRÉDIENTS & PRIX ---
app.get('/api/ingredients', (req, res) => {
    db.all("SELECT * FROM ingredients", [], (err, ingredients) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all("SELECT * FROM ingredient_prix", [], (err, prixList) => {
            if (err) return res.status(500).json({ error: err.message });

            const result = ingredients.map(i => ({
                ...i,
                prixList: prixList.filter(p => p.ingredient_id === i.id)
            }));
            res.json(result);
        });
    });
});

app.post('/api/ingredients', (req, res) => {
    const { nom, variete, rayon, unite, calories, proteines, glucides, lipides, prixList } = req.body;
    
    db.run(`INSERT INTO ingredients (nom, variete, rayon, unite, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [nom, variete || '', rayon || '', unite, calories || 0, proteines || 0, glucides || 0, lipides || 0], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const ingredientId = this.lastID;

            if (prixList && prixList.length > 0) {
                const stmt = db.prepare(`INSERT INTO ingredient_prix (ingredient_id, supermarche, marque, prix, conditionnement_quantite, conditionnement_unite) VALUES (?, ?, ?, ?, ?, ?)`);
                prixList.forEach(p => {
                    stmt.run([
                        ingredientId, 
                        p.supermarche || '', 
                        p.marque || '', 
                        parseFloat(p.prix) || 0, 
                        parseFloat(p.conditionnement_quantite) || 100, 
                        p.conditionnement_unite || 'g'
                    ]);
                });
                stmt.finalize();
            }

            io.emit('data_updated');
            res.json({ id: ingredientId });
        });
});

app.put('/api/ingredients/:id', (req, res) => {
    const { id } = req.params;
    const { nom, variete, rayon, unite, calories, proteines, glucides, lipides, prixList } = req.body;

    db.run(`UPDATE ingredients SET nom = ?, variete = ?, rayon = ?, unite = ?, calories = ?, proteines = ?, glucides = ?, lipides = ? WHERE id = ?`,
        [nom, variete || '', rayon || '', unite, calories || 0, proteines || 0, glucides || 0, lipides || 0, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });

            db.run(`DELETE FROM ingredient_prix WHERE ingredient_id = ?`, [id], (err) => {
                if (err) return res.status(500).json({ error: err.message });

                if (prixList && prixList.length > 0) {
                    const stmt = db.prepare(`INSERT INTO ingredient_prix (ingredient_id, supermarche, marque, prix, conditionnement_quantite, conditionnement_unite) VALUES (?, ?, ?, ?, ?, ?)`);
                    prixList.forEach(p => {
                        stmt.run([
                            id, 
                            p.supermarche || '', 
                            p.marque || '', 
                            parseFloat(p.prix) || 0, 
                            parseFloat(p.conditionnement_quantite) || 100, 
                            p.conditionnement_unite || 'g'
                        ]);
                    });
                    stmt.finalize();
                }

                io.emit('data_updated');
                res.json({ success: true });
            });
        });
});

app.delete('/api/ingredients/:id', (req, res) => {
    db.run(`DELETE FROM ingredients WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`DELETE FROM ingredient_prix WHERE ingredient_id = ?`, [req.params.id], () => {
            io.emit('data_updated');
            res.json({ success: true });
        });
    });
});

// --- ROUTES PROFILS ---
app.get('/api/profils', (req, res) => {
    db.all("SELECT * FROM profils", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/profils', (req, res) => {
    const { nom, calories_cible, proteines_cible, glucides_cible, lipides_cible, budget_semaine } = req.body;
    db.run(`INSERT INTO profils (nom, calories_cible, proteines_cible, glucides_cible, lipides_cible, budget_semaine) VALUES (?, ?, ?, ?, ?, ?)`,
        [nom, calories_cible || 2000, proteines_cible || 100, glucides_cible || 250, lipides_cible || 70, budget_semaine || 60], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: "Ce profil existe déjà !" });
                }
                return res.status(500).json({ error: err.message });
            }
            io.emit('data_updated');
            res.json({ id: this.lastID });
        });
});

app.put('/api/profils/:id', (req, res) => {
    const { nom, calories_cible, proteines_cible, glucides_cible, lipides_cible, budget_semaine } = req.body;
    db.run(`UPDATE profils SET nom = ?, calories_cible = ?, proteines_cible = ?, glucides_cible = ?, lipides_cible = ?, budget_semaine = ? WHERE id = ?`,
        [nom, calories_cible, proteines_cible, glucides_cible, lipides_cible, budget_semaine, req.params.id], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: "Ce nom de profil existe déjà !" });
                }
                return res.status(500).json({ error: err.message });
            }
            io.emit('data_updated');
            res.json({ success: true });
        });
});

app.delete('/api/profils/:id', (req, res) => {
    db.run(`DELETE FROM profils WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});

// --- ROUTES RECETTES ---
app.get('/api/recettes', (req, res) => {
    db.all("SELECT * FROM recettes", [], (err, recettes) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all(`SELECT ri.*, i.nom as ingredient_nom, i.variete, i.unite, i.calories, i.proteines, i.glucides, i.lipides 
                FROM recette_ingredients ri 
                JOIN ingredients i ON ri.ingredient_id = i.id`, [], (err, ingredients) => {
            if (err) return res.status(500).json({ error: err.message });

            const result = recettes.map(r => ({
                ...r,
                ingredients: ingredients.filter(ri => ri.recette_id === r.id)
            }));
            res.json(result);
        });
    });
});

app.post('/api/recettes', (req, res) => {
    const { nom, description, ingredients } = req.body;
    db.run(`INSERT INTO recettes (nom, description) VALUES (?, ?)`, [nom, description], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE')) {
                return res.status(400).json({ error: "Cette recette existe déjà !" });
            }
            return res.status(500).json({ error: err.message });
        }
        const recetteId = this.lastID;
        if (ingredients && ingredients.length > 0) {
            const stmt = db.prepare(`INSERT INTO recette_ingredients (recette_id, ingredient_id, quantite) VALUES (?, ?, ?)`);
            ingredients.forEach(ing => {
                stmt.run([recetteId, ing.ingredient_id, ing.quantite]);
            });
            stmt.finalize();
        }
        io.emit('data_updated');
        res.json({ id: recetteId });
    });
});

app.delete('/api/recettes/:id', (req, res) => {
    db.run(`DELETE FROM recettes WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`DELETE FROM recette_ingredients WHERE recette_id = ?`, [req.params.id], () => {
            io.emit('data_updated');
            res.json({ success: true });
        });
    });
});

server.listen(3000, () => console.log('Serveur actif sur http://localhost:3000'));