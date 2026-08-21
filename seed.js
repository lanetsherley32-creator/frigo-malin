const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('Erreur de connexion à la base de données', err.message);
        return;
    }
    console.log('Connecté à la base de données SQLite.');
});

// Données d'exemple : Ingrédients
const ingredients = [
    // Rayon: Fruits & Légumes
    { nom: 'Tomates', rayon: 'Fruits & Légumes', prix: 2.50, unite: 'kg', calories: 18, proteines: 0.9, glucides: 3.9, lipides: 0.2 },
    { nom: 'Oignons', rayon: 'Fruits & Légumes', prix: 1.50, unite: 'kg', calories: 40, proteines: 1.1, glucides: 9.3, lipides: 0.1 },
    { nom: 'Carottes', rayon: 'Fruits & Légumes', prix: 1.80, unite: 'kg', calories: 41, proteines: 0.9, glucides: 9.6, lipides: 0.2 },
    { nom: 'Salade', rayon: 'Fruits & Légumes', prix: 1.20, unite: 'unité', calories: 15, proteines: 1.4, glucides: 2.9, lipides: 0.2 },
    { nom: 'Pommes de terre', rayon: 'Fruits & Légumes', prix: 1.90, unite: 'kg', calories: 77, proteines: 2.0, glucides: 17.5, lipides: 0.1 },
    { nom: 'Courgettes', rayon: 'Fruits & Légumes', prix: 2.20, unite: 'kg', calories: 17, proteines: 1.2, glucides: 3.1, lipides: 0.3 },
    { nom: 'Bananes', rayon: 'Fruits & Légumes', prix: 2.10, unite: 'kg', calories: 89, proteines: 1.1, glucides: 22.8, lipides: 0.3 },
    { nom: 'Pommes', rayon: 'Fruits & Légumes', prix: 2.40, unite: 'kg', calories: 52, proteines: 0.3, glucides: 13.8, lipides: 0.2 },

    // Rayon: Viandes & Poissons
    { nom: 'Poulet (Escalopes)', rayon: 'Viandes & Poissons', prix: 12.00, unite: 'kg', calories: 165, proteines: 31.0, glucides: 0, lipides: 3.6 },
    { nom: 'Steak haché', rayon: 'Viandes & Poissons', prix: 10.50, unite: 'kg', calories: 250, proteines: 26.0, glucides: 0, lipides: 15.0 },
    { nom: 'Jambon blanc', rayon: 'Viandes & Poissons', prix: 8.50, unite: 'kg', calories: 145, proteines: 21.0, glucides: 1.0, lipides: 6.0 },
    { nom: 'Saumon (Pavé)', rayon: 'Viandes & Poissons', prix: 18.00, unite: 'kg', calories: 208, proteines: 20.0, glucides: 0, lipides: 13.0 },

    // Rayon: Produits Frais
    { nom: 'Œufs', rayon: 'Produits Frais', prix: 3.00, unite: 'boîte', calories: 155, proteines: 13.0, glucides: 1.1, lipides: 11.0 },
    { nom: 'Lait demi-écrémé', rayon: 'Produits Frais', prix: 1.10, unite: 'litre', calories: 46, proteines: 3.4, glucides: 4.8, lipides: 1.5 },
    { nom: 'Crème fraîche', rayon: 'Produits Frais', prix: 1.80, unite: 'pot', calories: 292, proteines: 2.3, glucides: 2.7, lipides: 30.0 },
    { nom: 'Beurre', rayon: 'Produits Frais', prix: 2.50, unite: 'plaquette', calories: 717, proteines: 0.85, glucides: 0.06, lipides: 81.0 },
    { nom: 'Emmental râpé', rayon: 'Produits Frais', prix: 7.00, unite: 'kg', calories: 380, proteines: 28.0, glucides: 1.5, lipides: 29.0 },
    { nom: 'Yaourt nature', rayon: 'Produits Frais', prix: 1.60, unite: 'pack', calories: 60, proteines: 3.5, glucides: 4.7, lipides: 3.3 },

    // Rayon: Épicerie & Sec
    { nom: 'Pâtes', rayon: 'Épicerie', prix: 1.40, unite: 'kg', calories: 350, proteines: 12.0, glucides: 70.0, lipides: 1.5 },
    { nom: 'Riz', rayon: 'Épicerie', prix: 1.90, unite: 'kg', calories: 130, proteines: 2.7, glucides: 28.0, lipides: 0.3 },
    { nom: 'Coulis de tomates', rayon: 'Épicerie', prix: 1.50, unite: 'bouteille', calories: 35, proteines: 1.5, glucides: 6.5, lipides: 0.4 },
    { nom: 'Huile d\'olive', rayon: 'Épicerie', prix: 8.00, unite: 'litre', calories: 884, proteines: 0, glucides: 0, lipides: 100.0 },
    { nom: 'Farine', rayon: 'Épicerie', prix: 0.90, unite: 'kg', calories: 364, proteines: 10.0, glucides: 76.0, lipides: 1.0 },
    { nom: 'Sucre', rayon: 'Épicerie', prix: 1.20, unite: 'kg', calories: 387, proteines: 0, glucides: 100.0, lipides: 0 }
];

// Données d'exemple : Recettes
const recettes = [
    { nom: 'Pâtes Bolognaises', calories: 620, proteines: 32, glucides: 75, lipides: 18 },
    { nom: 'Poulet Rôti & Pommes de terre', calories: 680, proteines: 45, glucides: 50, lipides: 22 },
    { nom: 'Omelette Fromage', calories: 410, proteines: 24, glucides: 2, lipides: 32 },
    { nom: 'Salade Composée au Jambon', calories: 320, proteines: 18, glucides: 12, lipides: 20 },
    { nom: 'Pavé de Saumon et Riz', calories: 550, proteines: 38, glucides: 45, lipides: 16 }
];

db.serialize(() => {
    // Insertion des ingrédients
    const stmtIng = db.prepare(`INSERT INTO ingredients (nom, rayon, prix, unite, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    ingredients.forEach(i => {
        stmtIng.run(i.nom, i.rayon, i.prix, i.unite, i.calories, i.proteines, i.glucides, i.lipides);
    });
    stmtIng.finalize();
    console.log('✅ Ingrédients de base insérés avec succès !');

    // Insertion des recettes
    const stmtRec = db.prepare(`INSERT INTO recettes (nom, calories, proteines, glucides, lipides) VALUES (?, ?, ?, ?, ?)`);
    recettes.forEach(r => {
        stmtRec.run(r.nom, r.calories, r.proteines, r.glucides, r.lipides);
    });
    stmtRec.finalize();
    console.log('✅ Recettes de base insérées avec succès !');
});

db.close((err) => {
    if (err) {
        console.error('Erreur fermeture base', err.message);
    }
    console.log('Base de données initialisée et prête à l’emploi.');
});