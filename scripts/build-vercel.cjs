const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const files = [
  'index.html',
  'admin.html',
  'student.html',
  'admin/index.html',
  'firebase-messaging-sw.js',
  'css/style.css',
  'js/admin.js',
  'js/auth.js',
  'js/firebase-config.js',
  'js/student.js',
  'js/xlsx.full.min.js'
];

fs.rmSync(output, { recursive: true, force: true });
for (const relativePath of files) {
  const source = path.join(root, relativePath);
  const destination = path.join(output, relativePath);
  if (!fs.existsSync(source)) throw new Error('Missing web asset: ' + relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

console.log('Built sanitized static site in dist/ (private roster files excluded).');
