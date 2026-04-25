import express from 'express';
import multer from 'multer';
import { backgroundRemove, cropImage, resizeImage, applyFilters } from '../controllers/imageController.js';

const router = express.Router();
import { UPLOAD_DIR } from '../utils/upload.js';
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 100 * 1024 * 1024 } });

router.post('/background-remove', upload.single('image'), backgroundRemove);
router.post('/crop-image',        upload.single('image'), cropImage);
router.post('/resize-image',      upload.single('image'), resizeImage);
router.post('/filters',           upload.single('image'), applyFilters);

export default router;
