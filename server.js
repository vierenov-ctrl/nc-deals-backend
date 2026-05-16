require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'nc-deals-secret-2026';
const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

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
  `);
  await pool.query('ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);');
  console.log('Base de données initialisée');
}

initDB().catch(console.error);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.post('/api/upload/sign', (req, res) => {
  const timestamp = Math.round(Date.now() / 1000);
  const folder = 'nc-deals/offres';
  const signature = cloudinary.utils.api_sign_request(
    { timestamp, folder },
    process.env.CLOUDINARY_API_SECRET
  );
  res.json({ signature, timestamp, folder,
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY });
});

app.post('/api/upload/webhook', async (req, res) => {
  const { public_id, secure_url } = req.body;
  await pool.query(
    'INSERT INTO photos (public_id, url, statut) VALUES ($1, $2, $3)',
    [public_id, secure_url, 'en_attente']
  );
  res.json({ status: 'reçu', public_id });
});

app.patch('/api/upload/moderate/:photoId', async (req, res) => {
  const { photoId } = req.params;
  const { action } = req.body;
  const statut = action === 'approuver' ? 'approuvee' : 'refusee';
if (action === 'refuser') {
  try { await cloudinary.uploader.destroy(photoId); } catch(e) { console.error('Cloudinary destroy error:', e); }
}
  await pool.query('UPDATE photos SET statut = $1 WHERE public_id = $2', [statut, photoId]);
  res.json({ status: statut, photoId });
});

app.get('/api/admin/photos', async (req, res) => {
  const result = await pool.query("SELECT * FROM photos WHERE statut = 'en_attente' ORDER BY cree_le DESC");
  res.json(result.rows);
});
app.get('/api/offres', async (req, res) => {
  const result = await pool.query(
    "SELECT o.*, p.url as photo_url FROM offres o LEFT JOIN photos p ON p.offre_id = o.id AND p.statut = 'approuvee' ORDER BY o.cree_le DESC"
  );
  res.json(result.rows);
});
// Créer ou mettre à jour un fournisseur
app.post('/api/fournisseurs', async (req, res) => {
  const { nom, email, iban, bic } = req.body;
  const result = await pool.query(
    `INSERT INTO fournisseurs (nom, email, iban, bic)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET iban=$3, bic=$4
     RETURNING *`,
    [nom, email, iban, bic]
  );
  res.json(result.rows[0]);
});

// Créer une offre
app.post('/api/offres', async (req, res) => {
  const { fournisseur_id, titre, description, prix_xpf } = req.body;
  const result = await pool.query(
    `INSERT INTO offres (fournisseur_id, titre, description, prix_xpf)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [fournisseur_id, titre, description, prix_xpf]
  );
  res.json(result.rows[0]);
});

// Lier une photo à une offre
app.patch('/api/photos/:photoId/offre', async (req, res) => {
  const { photoId } = req.params;
  const { offre_id } = req.body;
  await pool.query('UPDATE photos SET offre_id=$1 WHERE id=$2', [offre_id, photoId]);
  res.json({ ok: true });
});
app.post('/api/photos/save', async (req, res) => {
  const { public_id, url, offre_id } = req.body;
  await pool.query(
    'INSERT INTO photos (public_id, url, offre_id, statut) VALUES ($1, $2, $3, $4)',
    [public_id, url, offre_id, 'en_attente']
  );
  res.json({ ok: true });
});
app.get('/', (req, res) => res.send('NC Deals Backend OK'));

const PORT = process.env.PORT || 3000;
app.post('/api/auth/register', async (req, res) => {
  try {
    const { nom, email, password, iban, bic } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const existing = await pool.query('SELECT id, password_hash FROM fournisseurs WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      if (existing.rows[0].password_hash) {
        return res.status(400).json({ error: 'Cet email est déjà utilisé.' });
      }
      await pool.query('UPDATE fournisseurs SET password_hash = $1, nom = $2 WHERE email = $3', [hash, nom, email]);
      const token = jwt.sign({ id: existing.rows[0].id, email }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, nom, id: existing.rows[0].id });
    }
    const result = await pool.query(
      'INSERT INTO fournisseurs (nom, email, iban, bic, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id, nom',
      [nom, email, iban || null, bic || null, hash]
    );
    const token = jwt.sign({ id: result.rows[0].id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, nom: result.rows[0].nom, id: result.rows[0].id });
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

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM fournisseurs WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    const fournisseur = result.rows[0];
    if (!fournisseur.password_hash) return res.status(401).json({ error: 'Compte sans mot de passe — contactez l\'admin.' });
    const ok = await bcrypt.compare(password, fournisseur.password_hash);
    if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    const token = jwt.sign({ id: fournisseur.id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, nom: fournisseur.nom, id: fournisseur.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
