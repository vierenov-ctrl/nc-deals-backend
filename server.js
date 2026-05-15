require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');

const app = express();
app.use(cors());
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
  if (action === 'refuser') await cloudinary.uploader.destroy(photoId);
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

app.get('/', (req, res) => res.send('NC Deals Backend OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
