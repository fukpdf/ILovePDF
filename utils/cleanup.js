import fs from 'fs';

export function cleanupFiles(...files) {
  const allFiles = files.flat().filter(Boolean);
  setTimeout(() => {
    allFiles.forEach(file => {
      const filePath = typeof file === 'string' ? file : file?.path;
      if (filePath && fs.existsSync(filePath)) {
        fs.unlink(filePath, err => {
          if (err) console.error('Cleanup error:', err.message);
        });
      }
    });
  }, 8000);
}

export function sendPdf(res, bytes, filename = 'output.pdf') {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(bytes));
}

export function placeholder(res, toolName) {
  return res.status(501).json({
    coming_soon: true,
    message: `${toolName} is coming soon and is currently in development.`
  });
}
function toggleSidebar(){document.querySelector(".sidebar").classList.toggle("active")}
