require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Route 1 — Génère une signature pour upload sécurisé
app.post('/api/upload/sign', (req, res) => {
  const timestamp = Math.round(Date.now() / 1000);
  const folder = 'nc-deals/offres';
  const signature = cloudinary.utils.api_sign_request(
    { timestamp, folder },
    process.env.CLOUDINARY_API_SECRET
  );
  res.json({
    signature,
    timestamp,
    folder,
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
  });
});

// Route 2 — Reçoit le callback Cloudinary après upload
app.post('/api/upload/webhook', (req, res) => {
  const { public_id, secure_url, original_filename } = req.body;
  console.log('Photo reçue :', { public_id, secure_url, original_filename });
  // TODO: sauvegarder en base de données avec statut "en_attente"
  res.json({ status: 'reçu', public_id });
});

// Route 3 — Admin approuve ou refuse une photo
app.patch('/api/upload/moderate/:photoId', async (req, res) => {
  const { photoId } = req.params;
  const { action } = req.body; // "approuver" ou "refuser"
  if (action === 'refuser') {
    await cloudinary.uploader.destroy(photoId);
  }
  // TODO: mettre à jour le statut en base de données
  res.json({ status: action, photoId });
});

app.get('/', (req, res) => res.send('NC Deals Backend OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
