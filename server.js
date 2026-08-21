const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();

app.use(express.json());
// Utilise le dossier courant pour trouver vos pages HTML
app.use(express.static(__dirname));

// Connexion à la base de données
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// Initialisation automatique et forcée de la base de données
db.serialize(() => {
    // Suppression des anciennes tables pour repartir sur du propre
    db.run(`DROP TABLE IF EXISTS ingredients`);
    db.run(`DROP TABLE IF EXISTS recettes`);

    // Recréation des tables avec les bons champs
    db.run(`CREATE TABLE ingredients (
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

    db.run(`CREATE TABLE recettes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT,
        calories REAL,
        proteines REAL,
        glucides REAL,
        lipides REAL
    )`, (err) => {
        if (!err) {
            console.log("Tables créées, insertion des données par défaut...");
            
            // Insertion des ingrédients
            const stmtIng = db.prepare(`INSERT INTO ingredients (nom, marque, format, unite, rayon, prixLeclerc, prixCarrefour, prixLidl, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            
            const ingredientsDefaut = [
                ['Tomates', 'Bio', '1kg', 'g', 'Fruits et Légumes', 2.5, 2.8, 2.2, 18, 0.9, 3.9, 0.2],
                ['Pâtes penne', 'Barilla', '500g', 'g', 'Épicerie', 1.2, 1.4, 1.1, 350, 12.0, 70.0, 1.5],
                ['Escalopes de poulet', 'Le Gaulois', '400g', 'g', 'Frais', 6.5, 7.0, 6.0, 165, 31.0, 0, 3.6],
                ['Œufs x6', 'Fermiers', '6 pièces', 'pièce', 'Frais', 1.8, 1.9, 1.7, 155, 13.0, 1.1, 11.0]
            ];
            
            ingredientsDefaut.forEach(i => stmtIng.run(i));
            stmtIng.finalize();

            // Insertion des recettes
            const stmtRec = db.prepare(`INSERT INTO recettes (nom, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?)`);
            const recettesDefaut = [
                ['Pâtes Bolognaises', 620, 32, 75, 18],
                ['Omelette Fromage', 410, 24, 2, 32]
            ];
            recettesDefaut.forEach(r => stmtRec.run(r));
            stmtRec.finalize();
            
            console.log("✅ Données par défaut insérées avec succès.");
        }
    });
});

// --- Routes API Ingrédients ---
app.get('/api/ingredients', (req, res) => {
    db.all("SELECT * FROM ingredients", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/ingredients', (req, res) => {
    const { nom, marque, format, unite, rayon, prixLeclerc, prixCarrefour, prixLidl, calories, proteines, glucides, lipides } = req.body;
    const query = `INSERT INTO ingredients (nom, marque, format, unite, rayon, prixLeclerc, prixCarrefour, prixLidl, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(query, [nom, marque, format, unite, rayon, prixLeclerc, prixCarrefour, prixLidl, calories, proteines, glucides, lipides], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.delete('/api/ingredients/:id', (req, res) => {
    db.run("DELETE FROM ingredients WHERE id = ?", req.params.id, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- Routes API Recettes ---
app.get('/api/recettes', (req, res) => {
    db.all("SELECT * FROM recettes", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Lancement du serveur sur le port configuré par Render ou 10000 par défaut
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});