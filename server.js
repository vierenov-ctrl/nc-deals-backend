require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'nc-deals-secret-2026';
const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const TAUX_COMMISSION = 0.04;
const XPF_PAR_EUR = 119.33174;

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','stripe-signature'] }));
app.options('*', cors());

/* ── WEBHOOK STRIPE — doit être AVANT express.json() ── */
app.post('/api/webhook-stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { offre_id, fournisseur_id, montant_xpf } = session.metadata;
    const commission = Math.round(parseInt(montant_xpf) * TAUX_COMMISSION);
    try {
      await pool.query(
        `INSERT INTO commandes (offre_id, fournisseur_id, client_email, montant_xpf, commission_xpf, stripe_session_id)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (stripe_session_id) DO NOTHING`,
        [parseInt(offre_id), parseInt(fournisseur_id), session.customer_email, parseInt(montant_xpf), commission, session.id]
      );
    } catch (e) { console.error('DB error webhook:', e.message); }
  }

  res.json({ received: true });
});

app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fournisseurs (
      id SERIAL PRIMARY KEY,
      nom VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      iban VARCHAR(50),
      bic VARCHAR(20),
      cree_le TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS offres (
      id SERIAL PRIMARY KEY,
      fournisseur_id INTEGER REFERENCES fournisseurs(id),
      titre VARCHAR(255) NOT NULL,
      description TEXT,
      prix_xpf INTEGER,
      cree_le TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      offre_id INTEGER REFERENCES offres(id),
      public_id VARCHAR(255) NOT NULL,
      url VARCHAR(500) NOT NULL,
      statut VARCHAR(20) DEFAULT 'en_attente',
      cree_le TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS paiements (
      id SERIAL PRIMARY KEY,
      fournisseur_id INTEGER REFERENCES fournisseurs(id),
      montant_xpf INTEGER NOT NULL,
      reference VARCHAR(255),
      note TEXT,
      cree_le TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS commandes (
      id SERIAL PRIMARY KEY,
      offre_id INTEGER REFERENCES offres(id),
      fournisseur_id INTEGER REFERENCES fournisseurs(id),
      client_email VARCHAR(255),
      montant_xpf INTEGER,
      commission_xpf INTEGER,
      stripe_session_id VARCHAR(255) UNIQUE,
      statut VARCHAR(20) DEFAULT 'paye',
      cree_le TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query('ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);');
  await pool.query('ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS actif BOOLEAN DEFAULT true;');
  await pool.query("ALTER TABLE offres ADD COLUMN IF NOT EXISTS statut VARCHAR(20) DEFAULT 'en_attente';");
  await pool.query("ALTER TABLE offres ADD COLUMN IF NOT EXISTS categorie VARCHAR(50) DEFAULT 'Autres';");
  console.log('Base de données initialisée');
}
initDB().catch(console.error);

/* ── AUTH ── */

app.post('/api/auth/register', async (req, res) => {
  try {
    const { nom, email, password, iban, bic } = req.body;
    if (!iban) return res.status(400).json({ error: 'L\'IBAN est obligatoire pour recevoir vos paiements.' });
    const hash = await bcrypt.hash(password, 10);
    const existing = await pool.query('SELECT id, password_hash FROM fournisseurs WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      if (existing.rows[0].password_hash) return res.status(400).json({ error: 'Cet email est déjà utilisé.' });
      await pool.query('UPDATE fournisseurs SET password_hash = $1, nom = $2, iban = $3 WHERE email = $4', [hash, nom, iban, email]);
      const token = jwt.sign({ id: existing.rows[0].id, email }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, nom, id: existing.rows[0].id });
    }
    const result = await pool.query(
      'INSERT INTO fournisseurs (nom, email, iban, bic, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id, nom',
      [nom, email, iban, bic || null, hash]
    );
    const token = jwt.sign({ id: result.rows[0].id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, nom: result.rows[0].nom, id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM fournisseurs WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    const fournisseur = result.rows[0];
    if (!fournisseur.password_hash) return res.status(401).json({ error: 'Compte sans mot de passe — contactez l\'admin.' });
    if (fournisseur.actif === false) return res.status(403).json({ error: 'Votre compte a été désactivé. Contactez l\'administrateur.' });
    const ok = await bcrypt.compare(password, fournisseur.password_hash);
    if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    const token = jwt.sign({ id: fournisseur.id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, nom: fournisseur.nom, id: fournisseur.id, iban: fournisseur.iban });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const { email, new_password, admin_key } = req.body;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Clé admin incorrecte.' });
    const hash = await bcrypt.hash(new_password, 10);
    const result = await pool.query('UPDATE fournisseurs SET password_hash = $1 WHERE email = $2 RETURNING id', [hash, email]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Email introuvable.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── OFFRES ── */

app.get('/api/offres', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, f.nom as fournisseur_nom,
        (SELECT url FROM photos WHERE offre_id = o.id AND statut = 'approuvee' LIMIT 1) as photo_url
      FROM offres o
      LEFT JOIN fournisseurs f ON f.id = o.fournisseur_id
      WHERE o.statut = 'approuvee'
      ORDER BY o.cree_le DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/offres/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, f.nom as fournisseur_nom, f.email as fournisseur_email
      FROM offres o
      LEFT JOIN fournisseurs f ON f.id = o.fournisseur_id
      WHERE o.id = $1 AND o.statut = 'approuvee'
    `, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Offre introuvable.' });
    const photos = await pool.query("SELECT url FROM photos WHERE offre_id = $1 AND statut = 'approuvee' ORDER BY cree_le ASC", [req.params.id]);
    res.json({ ...result.rows[0], photos: photos.rows.map(p => p.url) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/offres', async (req, res) => {
  try {
    const { fournisseur_id, titre, description, prix_xpf, categorie } = req.body;
    const result = await pool.query(
      "INSERT INTO offres (fournisseur_id, titre, description, prix_xpf, categorie, statut) VALUES ($1, $2, $3, $4, $5, 'en_attente') RETURNING id",
      [fournisseur_id, titre, description || null, prix_xpf || 0, categorie || 'Autres']
    );
    res.json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── STRIPE PAIEMENT ── */

app.post('/api/creer-paiement', async (req, res) => {
  try {
    const { offre_id, client_email } = req.body;
    if (!offre_id || !client_email) return res.status(400).json({ error: 'offre_id et client_email requis.' });

    const result = await pool.query(`
      SELECT o.*, f.nom as fournisseur_nom
      FROM offres o LEFT JOIN fournisseurs f ON f.id = o.fournisseur_id
      WHERE o.id = $1 AND o.statut = 'approuvee'
    `, [offre_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Offre introuvable.' });

    const offre = result.rows[0];
    const montant_eur_cents = Math.round((offre.prix_xpf / XPF_PAR_EUR) * 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: client_email,
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: montant_eur_cents,
          product_data: {
            name: offre.titre,
            description: offre.description || ('NC Deals — ' + (offre.categorie || 'Offre')),
          },
        },
        quantity: 1,
      }],
      metadata: {
        offre_id: String(offre_id),
        fournisseur_id: String(offre.fournisseur_id),
        montant_xpf: String(offre.prix_xpf),
      },
      success_url: 'https://vierenov-ctrl.github.io/nc-deals-frontend/succes.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://vierenov-ctrl.github.io/nc-deals-frontend/offre.html?id=' + offre_id,
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── ADMIN COMMANDES ── */

app.get('/api/admin/commandes', async (req, res) => {
  try {
    const { admin_key } = req.query;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Acces refuse.' });
    const result = await pool.query(`
      SELECT c.*, o.titre as offre_titre, f.nom as fournisseur_nom, f.iban
      FROM commandes c
      LEFT JOIN offres o ON o.id = c.offre_id
      LEFT JOIN fournisseurs f ON f.id = c.fournisseur_id
      ORDER BY c.cree_le DESC
    `);
    const total_commissions = result.rows.reduce((s, r) => s + (r.commission_xpf || 0), 0);
    res.json({ commandes: result.rows, total_commissions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── ADMIN OFFRES ── */

app.get('/api/admin/offres', async (req, res) => {
  try {
    const { admin_key } = req.query;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Acces refuse.' });
    const result = await pool.query(`
      SELECT o.*, f.nom as fournisseur_nom,
        (SELECT url FROM photos WHERE offre_id = o.id LIMIT 1) as photo_url
      FROM offres o LEFT JOIN fournisseurs f ON f.id = o.fournisseur_id
      ORDER BY o.cree_le DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/offres/:id/statut', async (req, res) => {
  try {
    const { admin_key, statut } = req.body;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Acces refuse.' });
    await pool.query('UPDATE offres SET statut = $1 WHERE id = $2', [statut, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── ADMIN FOURNISSEURS ── */

app.get('/api/admin/fournisseurs', async (req, res) => {
  try {
    const { admin_key } = req.query;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Acces refuse.' });
    const result = await pool.query('SELECT id, nom, email, iban, bic, actif, cree_le FROM fournisseurs ORDER BY cree_le DESC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/fournisseurs/:id/statut', async (req, res) => {
  try {
    const { admin_key, actif } = req.body;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Acces refuse.' });
    await pool.query('UPDATE fournisseurs SET actif = $1 WHERE id = $2', [actif, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── PAIEMENTS (virements manuels) ── */

app.post('/api/admin/paiements', async (req, res) => {
  try {
    const { admin_key, fournisseur_id, montant_xpf, reference, note } = req.body;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Acces refuse.' });
    if (!fournisseur_id || !montant_xpf) return res.status(400).json({ error: 'Fournisseur et montant requis.' });
    await pool.query(
      'INSERT INTO paiements (fournisseur_id, montant_xpf, reference, note) VALUES ($1, $2, $3, $4)',
      [fournisseur_id, montant_xpf, reference || null, note || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/paiements', async (req, res) => {
  try {
    const { admin_key } = req.query;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Acces refuse.' });
    const result = await pool.query(`
      SELECT p.*, f.nom as fournisseur_nom, f.iban
      FROM paiements p
      LEFT JOIN fournisseurs f ON f.id = p.fournisseur_id
      ORDER BY p.cree_le DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/fournisseurs/:id/paiements', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM paiements WHERE fournisseur_id = $1 ORDER BY cree_le DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── PHOTOS ── */

app.post('/api/photos/save', async (req, res) => {
  try {
    const { public_id, url, offre_id } = req.body;
    await pool.query(
      "INSERT INTO photos (public_id, url, offre_id, statut) VALUES ($1, $2, $3, 'en_attente')",
      [public_id, url, offre_id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/photos', async (req, res) => {
  try {
    const { admin_key } = req.query;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Acces refuse.' });
    const result = await pool.query("SELECT * FROM photos WHERE statut = 'en_attente' ORDER BY cree_le DESC");
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/upload/moderate/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const { action, admin_key } = req.body;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Acces refuse.' });
    const statut = action === 'approuver' ? 'approuvee' : 'refusee';
    if (action === 'refuser') {
      try { await cloudinary.uploader.destroy(photoId); } catch (e) { console.error('Cloudinary destroy error:', e); }
    }
    await pool.query('UPDATE photos SET statut = $1 WHERE public_id = $2', [statut, photoId]);
    res.json({ status: statut, photoId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/fournisseurs', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nom, email, iban, bic, cree_le FROM fournisseurs ORDER BY cree_le DESC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
