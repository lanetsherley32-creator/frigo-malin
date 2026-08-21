const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('public')); // Assurez-vous que vos .html sont dans le dossier /public

// Connexion à la base de données
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// Initialisation automatique de la base
db.serialize(() => {
    // Création des tables
    db.run(`CREATE TABLE IF NOT EXISTS ingredients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT, rayon TEXT, prix REAL, unite TEXT, 
        calories REAL, proteines REAL, glucides REAL, lipides REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS recettes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT, calories REAL, proteines REAL, glucides REAL, lipides REAL
    )`);

    // Remplissage automatique si vide
    db.get("SELECT count(*) as count FROM ingredients", (err, row) => {
        if (!err && row.count === 0) {
            console.log("Base vide : initialisation des données...");
            
            const stmtIng = db.prepare(`INSERT INTO ingredients (nom, rayon, prix, unite, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
            const ingredients = [
                ['Tomates', 'Fruits & Légumes', 2.5, 'kg', 18, 0.9, 3.9, 0.2],
                ['Oignons', 'Fruits & Légumes', 1.5, 'kg', 40, 1.1, 9.3, 0.1],
                ['Poulet (Escalopes)', 'Viandes & Poissons', 12.0, 'kg', 165, 31.0, 0, 3.6],
                ['Pâtes', 'Épicerie', 1.4, 'kg', 350, 12.0, 70.0, 1.5],
                ['Œufs', 'Produits Frais', 3.0, 'boîte', 155, 13.0, 1.1, 11.0]
            ];
            ingredients.forEach(i => stmtIng.run(i));
            stmtIng.finalize();

            const stmtRec = db.prepare(`INSERT INTO recettes (nom, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?)`);
            const recettes = [
                ['Pâtes Bolognaises', 620, 32, 75, 18],
                ['Olette Fromage', 410, 24, 2, 32]
            ];
            recettes.forEach(r => stmtRec.run(r));
            stmtRec.finalize();
            
            console.log("✅ Données insérées avec succès.");
        }
    });
});

// Vos routes API (ajoutez vos routes existantes ici)
// Exemple :
app.get('/api/ingredients', (req, res) => {
    db.all("SELECT * FROM ingredients", [], (err, rows) => {
        res.json(rows);
    });
});

app.get('/api/recettes', (req, res) => {
    db.all("SELECT * FROM recettes", [], (err, rows) => {
        res.json(rows);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});