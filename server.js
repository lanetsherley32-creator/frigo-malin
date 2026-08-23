const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Configuration de la base de données PostgreSQL (ajustez les paramètres selon vos besoins)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/nom_de_base'
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- API GESTION DES PROFILS ET OBJECTIFS ---
app.get('/api/profils', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM personnes_objectifs");
        res.json(result.rows || []);
    } catch (err) {
        console.error("Erreur récupération profils :", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/profils', async (req, res) => {
    const { nom, calories, proteines, glucides, lipides, fibres, sucre, budget, compte_email } = req.body;
    try {
        const q = `
            INSERT INTO personnes_objectifs (nom, calories, proteines, glucides, lipides, fibres, sucre, budget, compte_email)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (nom) DO UPDATE SET 
                calories = EXCLUDED.calories,
                proteines = EXCLUDED.proteines,
                glucides = EXCLUDED.glucides,
                lipides = EXCLUDED.lipides,
                fibres = EXCLUDED.fibres,
                sucre = EXCLUDED.sucre,
                budget = EXCLUDED.budget,
                compte_email = EXCLUDED.compte_email
        `;
        await pool.query(q, [nom, calories, proteines, glucides, lipides, fibres, sucre, budget, compte_email]);
        io.emit('data_updated');
        res.sendStatus(200);
    } catch (err) {
        console.error("Erreur sauvegarde profil :", err);
        res.status(500).json({ error: err.message });
    }
});

// --- API RECHERCHE GLOBALE ET AUTOCOMPLÉTION (PARTIE 1 & DÉBUT) ---
app.get('/api/recherche-globale', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil || !jour) return res.status(400).json({ error: "Profil ou jour manquant" });

    try {
        const objRes = await pool.query("SELECT * FROM personnes_objectifs WHERE nom = $1", [profil]);
        const obj = objRes.rows[0] || {};
        const cible = {
            calories: parseFloat(obj.calories) || 2000,
            proteines: parseFloat(obj.proteines) || 120,
            glucides: parseFloat(obj.glucides) || 200,
            lipides: parseFloat(obj.lipides) || 70,
            fibres: parseFloat(obj.fibres) || 30,
            sucre: parseFloat(obj.sucre) || 50,
            budget: parseFloat(obj.budget) || 100
        };

        const suiviRes = await pool.query(`
            SELECT r.parts,
                   COALESCE(r.calories, i.calories) as calories,
                   COALESCE(r.proteines, i.proteines) as proteines,
                   COALESCE(r.glucides, i.glucides) as glucides,
                   COALESCE(r.lipides, i.lipides) as lipides,
                   COALESCE(r.fibres, i.fibres) as fibres,
                   COALESCE(r.sucre, i.sucre) as sucre,
                   COALESCE(r.cout, 0) as cout
            FROM suivi_conso s
            LEFT JOIN recettes r ON s.type_element = 'recette' AND s.element_id = r.id
            LEFT JOIN ingredients i ON s.type_element = 'aliment' AND s.element_id = i.id
            WHERE s.profil = $1 AND s.jour = $2
        `, [profil, jour]);

        let consomme = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 };
        suiviRes.rows.forEach(row => {
            const ratioPart = 1 / (parseFloat(row.parts) || 1);
            consomme.calories += (parseFloat(row.calories) || 0) * ratioPart;
            consomme.proteines += (parseFloat(row.proteines) || 0) * ratioPart;
            consomme.glucides += (parseFloat(row.glucides) || 0) * ratioPart;
            consomme.lipides += (parseFloat(row.lipides) || 0) * ratioPart;
            consomme.fibres += (parseFloat(row.fibres) || 0) * ratioPart;
            consomme.sucre += (parseFloat(row.sucre) || 0) * ratioPart;
            consomme.cout += (parseFloat(row.cout) || 0) * ratioPart;
        });

        const recettesRes = await pool.query("SELECT * FROM recettes");
        const recettes = recettesRes.rows || [];

        const ingredientsRes = await pool.query("SELECT * FROM ingredients");
        const ingredients = ingredientsRes.rows || [];

        // Fusion des résultats pour l'autocomplétion / saisie manuelle
        let tousLesChoix = [...recettes, ...ingredients];

        // 3. Application de l'intelligence de recommandation (Tri & Vert en 1ère proposition)
        tousLesChoix = tousLesChoix.map(item => {
            const parts = parseFloat(item.parts) || 1;
            const ratioPart = 1 / parts;
            const cal = (parseFloat(item.calories) || 0) * ratioPart;
            const pro = (parseFloat(item.proteines) || 0) * ratioPart;
            const glu = (parseFloat(item.glucides) || 0) * ratioPart;
            const lip = (parseFloat(item.lipides) || 0) * ratioPart;
            const fib = (parseFloat(item.fibres) || 0) * ratioPart;
            const suc = (parseFloat(item.sucre) || 0) * ratioPart;
            const cout = (parseFloat(item.cout) || 0) * ratioPart;

            let penalite = 0;

            // En-dessus de l'objectif (à limiter / ne pas dépasser) : Calories, Lipides, Glucides, Sucre, Budget
            if ((consomme.calories + cal) > cible.calories) penalite += ((consomme.calories + cal) - cible.calories) * 2;
            if ((consomme.lipides + lip) > cible.lipides) penalite += ((consomme.lipides + lip) - cible.lipides) * 2;
            if ((consomme.glucides + glu) > cible.glucides) penalite += ((consomme.glucides + glu) - cible.glucides) * 1.5;
            if ((consomme.sucre + suc) > cible.sucre) penalite += ((consomme.sucre + suc) - cible.sucre) * 3;
            if ((consomme.cout + cout) > (cible.budget / 7)) penalite += ((consomme.cout + cout) - (cible.budget / 7)) * 5;

            // Au-dessus de l'objectif (à encourager / augmenter) : Protéines, Fibres (on réduit la pénalité/score pour les remonter)
            if ((consomme.proteines + pro) < cible.proteines) penalite -= pro * 2.5;
            if ((consomme.fibres + fib) < cible.fibres) penalite -= fib * 2.5;

            // Détermine si l'élément aide à combler les manques (PROT / FIBRES) sans exploser les limites -> Recommandé en vert
            const aideProtéinesOuFibres = ((consomme.proteines < cible.proteines && pro >= 10) || (consomme.fibres < cible.fibres && fib >= 3));
            const respecteLimites = (consomme.calories + cal <= cible.calories * 1.1) && (consomme.sucre + suc <= cible.sucre);
            const recommandeEnVert = aideProtéinesOuFibres && respecteLimites;

            return {
                ...item,
                scoreRecommandation: penalite,
                recommandeEnVert: recommandeEnVert
            };
        });

        // Tri : Les plus bas scores de pénalité (et ceux en vert) d'abord
        tousLesChoix.sort((a, b) => {
            if (a.recommandeEnVert && !b.recommandeEnVert) return -1;
            if (!a.recommandeEnVert && b.recommandeEnVert) return 1;
            return a.scoreRecommandation - b.scoreRecommandation;
        });

        res.json(tousLesChoix);
    } catch (err) {
        console.error("Erreur recherche globale :", err);
        res.status(500).json({ error: err.message });
    }
});

// --- CALCUL DE SCORE ---
function calculerScoreEcart(recette, cible) {
    const calR = parseFloat(recette.calories) || 0;
    const proR = parseFloat(recette.proteines) || 0;
    const gluR = parseFloat(recette.glucides) || 0;
    const lipR = parseFloat(recette.lipides) || 0;

    let scoreCal = Math.abs(calR - cible.calories);
    if (calR > cible.calories) scoreCal *= 2; 

    let scorePro = proR >= cible.proteines ? 0 : (cible.proteines - proR) * 2.5;

    let scoreGlu = gluR > cible.glucides ? (gluR - cible.glucides) * 2 : Math.abs(gluR - cible.glucides) * 0.5;
    let scoreLip = lipR > cible.lipides ? (lipR - cible.lipides) * 2 : Math.abs(lipR - cible.lipides) * 0.5;

    return scoreCal + scorePro + scoreGlu + scoreLip;
}

// --- API RECETTES & INGRÉDIENTS (CRUD DE BASE) ---
app.get('/api/recettes', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM recettes");
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/ingredients', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM ingredients");
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API MENU PRÉVU ---
app.get('/api/menus', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM menu_prevu");
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/menu-prevu-semaine', async (req, res) => {
    const profil = req.query.profil;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });
    try {
        const result = await pool.query("SELECT * FROM menu_prevu WHERE profil = $1", [profil]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/menu-prevu-resume-jour', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil || !jour) return res.status(400).json({ error: "Profil ou jour manquant" });
    
    try {
        const menuRes = await pool.query(
            "SELECT petitdejeuner, repas1, repas2, dessertcollation FROM menu_prevu WHERE profil = $1 AND jour = $2", 
            [profil, jour]
        );
        const menu = menuRes.rows[0];
        
        if (!menu) {
            return res.json({ calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 });
        }
        
        const idsRecettes = [menu.petitdejeuner, menu.repas1, menu.repas2, menu.dessertcollation].filter(Boolean);
        
        if (idsRecettes.length === 0) {
            return res.json({ calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 });
        }
        
        const placeholders = idsRecettes.map((_, i) => `$${i + 1}`).join(',');
        const recettesRes = await pool.query(`SELECT parts, calories, proteines, glucides, lipides, fibres, sucre, cout FROM recettes WHERE id IN (${placeholders})`, idsRecettes);
        
        let totaux = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 };
        
        recettesRes.rows.forEach(r => {
            const parts = parseFloat(r.parts) || 1;
            const ratioPart = 1 / parts;
            
            totaux.calories += (parseFloat(r.calories) || 0) * ratioPart;
            totaux.proteines += (parseFloat(r.proteines) || 0) * ratioPart;
            totaux.glucides += (parseFloat(r.glucides) || 0) * ratioPart;
            totaux.lipides += (parseFloat(r.lipides) || 0) * ratioPart;
            totaux.fibres += (parseFloat(r.fibres) || 0) * ratioPart;
            totaux.sucre += (parseFloat(r.sucre) || 0) * ratioPart;
            totaux.cout += (parseFloat(r.cout) || 0) * ratioPart;
        });
        
        res.json(totaux);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/menu-prevu', async (req, res) => {
    const { profil, jour, petitDejeuner, repas1, repas2, dessertCollation } = req.body;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });

    const q = `
        INSERT INTO menu_prevu (profil, jour, petitdejeuner, repas1, repas2, dessertcollation) 
        VALUES ($1, $2, $3, $4, $5, $6) 
        ON CONFLICT (profil, jour) DO UPDATE SET 
            petitdejeuner = EXCLUDED.petitdejeuner, 
            repas1 = EXCLUDED.repas1, 
            repas2 = EXCLUDED.repas2, 
            dessertcollation = EXCLUDED.dessertcollation
    `;
    try {
        await pool.query(q, [profil, jour, petitDejeuner || null, repas1 || null, repas2 || null, dessertCollation || null]);
        io.emit('data_updated');
        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 2. LOGIQUE COMMUNE POUR LA GÉNÉRATION ALÉATOIRE AVEC FILTRAGE PAR CATÉGORIES ---
async function executerGenerationAleatoire(req) {
    let profil = req.body.profil;
    let categoriesFiltre = req.body.categories; // Tableau ou string ex: ["Petit-déjeuner", "Desserts"]

    if (!profil && req.session && req.session.user) {
        const userProfiles = await pool.query("SELECT nom FROM personnes_objectifs WHERE compte_email = $1 LIMIT 1", [req.session.user]);
        if (userProfiles.rows.length > 0) {
            profil = userProfiles.rows[0].nom;
        }
    }

    if (!profil) {
        throw new Error("Profil manquant");
    }

    const objRes = await pool.query("SELECT * FROM personnes_objectifs WHERE nom = $1", [profil]);
    const obj = objRes.rows[0] || {};
    
    const cibleJour = {
        calories: parseFloat(obj.calories) || 2000,
        proteines: parseFloat(obj.proteines) || 120,
        glucides: parseFloat(obj.glucides) || 200,
        lipides: parseFloat(obj.lipides) || 70,
        fibres: parseFloat(obj.fibres) || 30,
        sucre: parseFloat(obj.sucre) || 50
    };

    const budgetMaxSemaine = parseFloat(obj.budget) || 99999;

    const recettesRes = await pool.query("SELECT * FROM recettes");
    let recettes = recettesRes.rows || [];
    if (recettes.length === 0) throw new Error("Aucune recette disponible.");

    // Application du filtre par catégories si spécifié
    if (categoriesFiltre) {
        const catList = Array.isArray(categoriesFiltre) ? categoriesFiltre : categoriesFiltre.split(',').map(c => c.trim().toLowerCase());
        if (catList.length > 0) {
            recettes = recettes.filter(r => r.categorie && catList.includes(r.categorie.toLowerCase()));
        }
    }

    if (recettes.length === 0) throw new Error("Aucune recette ne correspond aux catégories sélectionnées.");

    const jours = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    const ratios = [0.20, 0.35, 0.35, 0.10]; 
    const repasKeys = ['petitDejeuner', 'repas1', 'repas2', 'dessertCollation'];

    let meilleureSemaine = null;
    let meilleurScoreGlobal = Infinity;

    for (let essai = 0; essai < 25; essai++) {
        let semaineCourante = {};
        let coutTotalSemaine = 0;
        let ingredientsSemaineQte = {};
        let scoreSemaine = 0;

        for (const jour of jours) {
            let selectionJour = {};
            for (let i = 0; i < repasKeys.length; i++) {
                const ratio = ratios[i];
                const sousCible = {
                    calories: cibleJour.calories * ratio,
                    proteines: cibleJour.proteines * ratio,
                    glucides: cibleJour.glucides * ratio,
                    lipides: cibleJour.lipides * ratio,
                    fibres: cibleJour.fibres * ratio,
                    sucre: cibleJour.sucre * ratio
                };

                const recettesTriees = [...recettes].sort((a, b) => {
                    let scoreA = calculerScoreEcart(a, sousCible);
                    let scoreB = calculerScoreEcart(b, sousCible);

                    try {
                        let ingsA = typeof a.ingredients === 'string' ? JSON.parse(a.ingredients) : a.ingredients;
                        if (Array.isArray(ingsA)) {
                            ingsA.forEach(ing => {
                                let id = ing.id || ing.ingredient_id;
                                if (id && ingredientsSemaineQte[id] && ingredientsSemaineQte[id].reste > 0) {
                                    scoreA -= 15;
                                }
                            });
                        }
                    } catch(e){}

                    try {
                        let ingsB = typeof b.ingredients === 'string' ? JSON.parse(b.ingredients) : b.ingredients;
                        if (Array.isArray(ingsB)) {
                            ingsB.forEach(ing => {
                                let id = ing.id || ing.ingredient_id;
                                if (id && ingredientsSemaineQte[id] && ingredientsSemaineQte[id].reste > 0) {
                                    scoreB -= 15;
                                }
                            });
                        }
                    } catch(e){}

                    return scoreA - scoreB;
                });

                const topChoices = recettesTriees.slice(0, Math.min(4, recettesTriees.length));
                const chosen = topChoices[Math.floor(Math.random() * topChoices.length)] || recettesTriees[0];

                selectionJour[repasKeys[i]] = chosen ? chosen.id : null;
                
                const parts = parseFloat(chosen?.parts) || 1;
                coutTotalSemaine += (parseFloat(chosen?.cout) || 0) / parts;

                try {
                    let ings = typeof chosen.ingredients === 'string' ? JSON.parse(chosen.ingredients) : chosen.ingredients;
                    if (Array.isArray(ings)) {
                        ings.forEach(ing => {
                            let id = ing.id || ing.ingredient_id;
                            let qteUtilisee = parseFloat(ing.quantite) || 0;
                            if (id) {
                                if (!ingredientsSemaineQte[id]) {
                                    ingredientsSemaineQte[id] = { reste: 0 };
                                }
                                ingredientsSemaineQte[id].reste += qteUtilisee;
                                if (ingredientsSemaineQte[id].reste >= 500) {
                                    ingredientsSemaineQte[id].reste = 0;
                                }
                            }
                        });
                    }
                } catch(e){}
            }
            semaineCourante[jour] = selectionJour;
        }

        let penaliteRestes = 0;
        Object.values(ingredientsSemaineQte).forEach(item => {
            if (item.reste > 0) penaliteRestes += item.reste * 0.05;
        });

        let penaliteBudget = coutTotalSemaine > budgetMaxSemaine ? (coutTotalSemaine - budgetMaxSemaine) * 50 : 0;
        scoreSemaine += penaliteBudget + penaliteRestes;

        if (scoreSemaine < meilleurScoreGlobal) {
            meilleurScoreGlobal = scoreSemaine;
            meilleureSemaine = semaineCourante;
        }
    }

    for (const jour of jours) {
        const sel = meilleureSemaine[jour];
        const q = `
            INSERT INTO menu_prevu (profil, jour, petitdejeuner, repas1, repas2, dessertcollation) 
            VALUES ($1, $2, $3, $4, $5, $6) 
            ON CONFLICT (profil, jour) DO UPDATE SET 
                petitdejeuner = EXCLUDED.petitdejeuner, 
                repas1 = EXCLUDED.repas1, 
                repas2 = EXCLUDED.repas2, 
                dessertcollation = EXCLUDED.dessertcollation
        `;
        await pool.query(q, [profil, jour, sel.petitDejeuner, sel.repas1, sel.repas2, sel.dessertCollation]);
    }

    io.emit('data_updated');
}

// --- API ROUTES DE GÉNÉRATION ---
app.post('/api/menu-aleatoire-optimise', async (req, res) => {
    try {
        await executerGenerationAleatoire(req);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/menus/generer-aleatoire', async (req, res) => {
    try {
        await executerGenerationAleatoire(req);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- API RECETTES RECOMMANDÉES (AVEC RÈGLES VERTES & OBJECTIFS) ---
app.get('/api/recettes-recommandees-optimisees', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil || !jour) return res.status(400).json({ error: "Profil ou jour manquant" });

    try {
        const objRes = await pool.query("SELECT * FROM personnes_objectifs WHERE nom = $1", [profil]);
        const obj = objRes.rows[0] || {};
        const cible = {
            calories: parseFloat(obj.calories) || 2000,
            proteines: parseFloat(obj.proteines) || 120,
            glucides: parseFloat(obj.glucides) || 200,
            lipides: parseFloat(obj.lipides) || 70,
            fibres: parseFloat(obj.fibres) || 30,
            sucre: parseFloat(obj.sucre) || 50,
            budget: parseFloat(obj.budget) || 100
        };

        const suiviRes = await pool.query(`
            SELECT r.parts,
                   COALESCE(r.calories, i.calories) as calories,
                   COALESCE(r.proteines, i.proteines) as proteines,
                   COALESCE(r.glucides, i.glucides) as glucides,
                   COALESCE(r.lipides, i.lipides) as lipides,
                   COALESCE(r.fibres, i.fibres) as fibres,
                   COALESCE(r.sucre, i.sucre) as sucre,
                   COALESCE(r.cout, 0) as cout
            FROM suivi_conso s
            LEFT JOIN recettes r ON s.type_element = 'recette' AND s.element_id = r.id
            LEFT JOIN ingredients i ON s.type_element = 'aliment' AND s.element_id = i.id
            WHERE s.profil = $1 AND s.jour = $2
        `, [profil, jour]);

        let consomme = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, cout: 0 };
        suiviRes.rows.forEach(row => {
            const ratioPart = 1 / (parseFloat(row.parts) || 1);
            consomme.calories += (parseFloat(row.calories) || 0) * ratioPart;
            consomme.proteines += (parseFloat(row.proteines) || 0) * ratioPart;
            consomme.glucides += (parseFloat(row.glucides) || 0) * ratioPart;
            consomme.lipides += (parseFloat(row.lipides) || 0) * ratioPart;
            consomme.fibres += (parseFloat(row.fibres) || 0) * ratioPart;
            consomme.sucre += (parseFloat(row.sucre) || 0) * ratioPart;
            consomme.cout += (parseFloat(row.cout) || 0) * ratioPart;
        });

        const recettesRes = await pool.query("SELECT * FROM recettes");
        const recettes = recettesRes.rows || [];

        const recos = recettes.map(r => {
            const parts = parseFloat(r.parts) || 1;
            const ratioPart = 1 / parts;
            const cal = (parseFloat(r.calories) || 0) * ratioPart;
            const pro = (parseFloat(r.proteines) || 0) * ratioPart;
            const glu = (parseFloat(r.glucides) || 0) * ratioPart;
            const lip = (parseFloat(r.lipides) || 0) * ratioPart;
            const fib = (parseFloat(r.fibres) || 0) * ratioPart;
            const suc = (parseFloat(r.sucre) || 0) * ratioPart;
            const cout = (parseFloat(r.cout) || 0) * ratioPart;

            let score = 0;
            // Limites à ne pas dépasser
            if ((consomme.calories + cal) > cible.calories) score += ((consomme.calories + cal) - cible.calories) * 2;
            if ((consomme.sucre + suc) > cible.sucre) score += ((consomme.sucre + suc) - cible.sucre) * 3;
            if ((consomme.lipides + lip) > cible.lipides) score += ((consomme.lipides + lip) - cible.lipides) * 2;
            if ((consomme.glucides + glu) > cible.glucides) score += ((consomme.glucides + glu) - cible.glucides) * 1.5;
            if ((consomme.cout + cout) > (cible.budget / 7)) score += ((consomme.cout + cout) - (cible.budget / 7)) * 5;

            // Objectifs à augmenter / encourager
            if ((consomme.proteines + pro) < cible.proteines) score -= pro * 2.5;
            if ((consomme.fibres + fib) < cible.fibres) score -= fib * 2.5;

            const aideProtéinesOuFibres = ((consomme.proteines < cible.proteines && pro >= 10) || (consomme.fibres < cible.fibres && fib >= 3));
            const respecteLimites = (consomme.calories + cal <= cible.calories * 1.1) && (consomme.sucre + suc <= cible.sucre);
            const recommandeEnVert = aideProtéinesOuFibres && respecteLimites;

            return { ...r, scoreRecommandation: score, recommandeEnVert };
        });

        recos.sort((a, b) => {
            if (a.recommandeEnVert && !b.recommandeEnVert) return -1;
            if (!a.recommandeEnVert && b.recommandeEnVert) return 1;
            return a.scoreRecommandation - b.scoreRecommandation;
        });

        res.json(recos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// =========================================================================
// --- ROUTES DE GESTION DU SUIVI DE CONSOMMATION (`suivi_conso`) ---
// =========================================================================

// Ajout d'un élément consommé dans la journée
app.post('/api/suivi-conso', async (req, res) => {
    const { profil, jour, type_element, element_id, eau } = req.body;
    if (!profil || !jour) return res.status(400).json({ error: "Profil ou jour manquant" });

    try {
        const q = `
            INSERT INTO suivi_conso (profil, jour, type_element, element_id, eau) 
            VALUES ($1, $2, $3, $4, $5)
        `;
        await pool.query(q, [profil, jour, type_element || null, element_id || null, eau || 0]);
        io.emit('data_updated');
        res.sendStatus(200);
    } catch (err) {
        console.error("Erreur ajout suivi_conso :", err);
        res.status(500).json({ error: err.message });
    }
});

// 1. Bloc "Semaine" : Cumul progressif de tous les apports (calories, protéines, glucides, lipides, fibres, sucre, eau) et du budget de la semaine
app.get('/api/suivi-semaine-resume', async (req, res) => {
    const { profil } = req.query;
    if (!profil) return res.status(400).json({ error: "Profil manquant" });

    try {
        const suiviRes = await pool.query(`
            SELECT r.parts,
                   COALESCE(r.calories, i.calories) as calories,
                   COALESCE(r.proteines, i.proteines) as proteines,
                   COALESCE(r.glucides, i.glucides) as glucides,
                   COALESCE(r.lipides, i.lipides) as lipides,
                   COALESCE(r.fibres, i.fibres) as fibres,
                   COALESCE(r.sucre, i.sucre) as sucre,
                   COALESCE(s.eau, 0) as eau,
                   COALESCE(r.cout, 0) as cout
            FROM suivi_conso s
            LEFT JOIN recettes r ON s.type_element = 'recette' AND s.element_id = r.id
            LEFT JOIN ingredients i ON s.type_element = 'aliment' AND s.element_id = i.id
            WHERE s.profil = $1
        `, [profil]);

        let cumulSemaine = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, eau: 0, cout: 0 };

        suiviRes.rows.forEach(row => {
            const ratioPart = 1 / (parseFloat(row.parts) || 1);
            cumulSemaine.calories += (parseFloat(row.calories) || 0) * ratioPart;
            cumulSemaine.proteines += (parseFloat(row.proteines) || 0) * ratioPart;
            cumulSemaine.glucides += (parseFloat(row.glucides) || 0) * ratioPart;
            cumulSemaine.lipides += (parseFloat(row.lipides) || 0) * ratioPart;
            cumulSemaine.fibres += (parseFloat(row.fibres) || 0) * ratioPart;
            cumulSemaine.sucre += (parseFloat(row.sucre) || 0) * ratioPart;
            cumulSemaine.eau += parseFloat(row.eau) || 0;
            cumulSemaine.cout += (parseFloat(row.cout) || 0) * ratioPart;
        });

        res.json(cumulSemaine);
    } catch (err) {
        console.error("Erreur résumé semaine :", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Suivi détaillé jour par jour : Apports et budget de chaque journée + liste des éléments consommés
app.get('/api/suivi-jour-detail', async (req, res) => {
    const { profil, jour } = req.query;
    if (!profil || !jour) return res.status(400).json({ error: "Profil ou jour manquant" });

    try {
        const suiviRes = await pool.query(`
            SELECT s.id, s.type_element, s.element_id, s.jour, s.eau,
                   COALESCE(r.nom, i.nom) as nom_element,
                   r.parts,
                   COALESCE(r.calories, i.calories) as calories,
                   COALESCE(r.proteines, i.proteines) as proteines,
                   COALESCE(r.glucides, i.glucides) as glucides,
                   COALESCE(r.lipides, i.lipides) as lipides,
                   COALESCE(r.fibres, i.fibres) as fibres,
                   COALESCE(r.sucre, i.sucre) as sucre,
                   COALESCE(r.cout, 0) as cout
            FROM suivi_conso s
            LEFT JOIN recettes r ON s.type_element = 'recette' AND s.element_id = r.id
            LEFT JOIN ingredients i ON s.type_element = 'aliment' AND s.element_id = i.id
            WHERE s.profil = $1 AND s.jour = $2
        `, [profil, jour]);

        let totauxJour = { calories: 0, proteines: 0, glucides: 0, lipides: 0, fibres: 0, sucre: 0, eau: 0, cout: 0 };
        let elements = [];

        suiviRes.rows.forEach(row => {
            const ratioPart = 1 / (parseFloat(row.parts) || 1);
            const cal = (parseFloat(row.calories) || 0) * ratioPart;
            const pro = (parseFloat(row.proteines) || 0) * ratioPart;
            const glu = (parseFloat(row.glucides) || 0) * ratioPart;
            const lip = (parseFloat(row.lipides) || 0) * ratioPart;
            const fib = (parseFloat(row.fibres) || 0) * ratioPart;
            const suc = (parseFloat(row.sucre) || 0) * ratioPart;
            const cout = (parseFloat(row.cout) || 0) * ratioPart;
            const eau = parseFloat(row.eau) || 0;

            totauxJour.calories += cal;
            totauxJour.proteines += pro;
            totauxJour.glucides += glu;
            totauxJour.lipides += lip;
            totauxJour.fibres += fib;
            totauxJour.sucre += suc;
            totauxJour.eau += eau;
            totauxJour.cout += cout;

            elements.push({
                id: row.id,
                type_element: row.type_element,
                element_id: row.element_id,
                nom: row.nom_element || (eau > 0 ? "Eau" : "Élément inconnu"),
                eau: eau,
                calories: Math.round(cal),
                proteines: Math.round(pro * 10) / 10,
                glucides: Math.round(glu * 10) / 10,
                lipides: Math.round(lip * 10) / 10,
                fibres: Math.round(fib * 10) / 10,
                sucre: Math.round(suc * 10) / 10,
                cout: Math.round(cout * 100) / 100
            });
        });

        res.json({ totaux: totauxJour, elements });
    } catch (err) {
        console.error("Erreur détail jour :", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Modifier un élément dans l'historique réel de la journée (suivi_conso)
app.put('/api/suivi-conso/:id', async (req, res) => {
    const { id } = req.params;
    const { element_id, type_element, eau } = req.body;

    try {
        const updateQuery = `
            UPDATE suivi_conso 
            SET element_id = COALESCE($1, element_id), 
                type_element = COALESCE($2, type_element), 
                eau = COALESCE($3, eau)
            WHERE id = $4
        `;
        await pool.query(updateQuery, [element_id || null, type_element || null, eau !== undefined ? eau : null, id]);
        io.emit('data_updated');
        res.sendStatus(200);
    } catch (err) {
        console.error("Erreur modification suivi_conso :", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Supprimer un élément dans l'historique réel de la journée (suivi_conso)
app.delete('/api/suivi-conso/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query("DELETE FROM suivi_conso WHERE id = $1", [id]);
        io.emit('data_updated');
        res.sendStatus(200);
    } catch (err) {
        console.error("Erreur suppression suivi_conso :", err);
        res.status(500).json({ error: err.message });
    }
});

// --- LANCEMENT DU SERVEUR ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});