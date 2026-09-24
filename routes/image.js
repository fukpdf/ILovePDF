import express from 'express';
import { backgroundRemove, cropImage, resizeImage, applyFilters } from '../controllers/imageController.js';

const router = express.Router();
import { createUpload } from '../utils/upload.js';
const upload = createUpload('image');

router.post('/background-remove', upload.single('image'), backgroundRemove);
router.post('/crop-image',        upload.single('image'), cropImage);
router.post('/resize-image',      upload.single('image'), resizeImage);
router.post('/filters',           upload.single('image'), applyFilters);

export default router;
