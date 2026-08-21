const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.db');

const schema = `
CREATE TABLE IF NOT EXISTS ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT,
    rayon TEXT,
    prix REAL,
    unite TEXT,
    calories REAL,
    proteines REAL,
    glucides REAL,
    lipides REAL
);
CREATE TABLE IF NOT EXISTS recettes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT,
    calories REAL,
    proteines REAL,
    glucides REAL,
    lipides REAL
);
`;

const ingredients = [
    { nom: 'Tomates', rayon: 'Fruits & Légumes', prix: 2.50, unite: 'kg', calories: 18, proteines: 0.9, glucides: 3.9, lipides: 0.2 },
    { nom: 'Oignons', rayon: 'Fruits & Légumes', prix: 1.50, unite: 'kg', calories: 40, proteines: 1.1, glucides: 9.3, lipides: 0.1 },
    { nom: 'Poulet (Escalopes)', rayon: 'Viandes & Poissons', prix: 12.00, unite: 'kg', calories: 165, proteines: 31.0, glucides: 0, lipides: 3.6 },
    { nom: 'Pâtes', rayon: 'Épicerie', prix: 1.40, unite: 'kg', calories: 350, proteines: 12.0, glucides: 70.0, lipides: 1.5 },
    { nom: 'Œufs', rayon: 'Produits Frais', prix: 3.00, unite: 'boîte', calories: 155, proteines: 13.0, glucides: 1.1, lipides: 11.0 }
];

const recettes = [
    { nom: 'Pâtes Bolognaises', calories: 620, proteines: 32, glucides: 75, lipides: 18 },
    { nom: 'Omelette Fromage', calories: 410, proteines: 24, glucides: 2, lipides: 32 }
];

db.serialize(() => {
    // 1. Création des tables
    db.exec(schema, (err) => {
        if (err) return console.error("Erreur création tables:", err.message);
        console.log('✅ Tables créées ou déjà existantes.');

        // 2. Insertion Ingrédients
        const stmtIng = db.prepare(`INSERT INTO ingredients (nom, rayon, prix, unite, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        ingredients.forEach(i => stmtIng.run(i.nom, i.rayon, i.prix, i.unite, i.calories, i.proteines, i.glucides, i.lipides));
        stmtIng.finalize();
        console.log('✅ Ingrédients insérés.');

        // 3. Insertion Recettes
        const stmtRec = db.prepare(`INSERT INTO recettes (nom, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?)`);
        recettes.forEach(r => stmtRec.run(r.nom, r.calories, r.proteines, r.glucides, r.lipides));
        stmtRec.finalize();
        console.log('✅ Recettes insérées.');
    });
});

db.close();