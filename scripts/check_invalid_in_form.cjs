const fs = require('fs');
const path = require('path');
const XLSX = require('../js/xlsx.full.min.js');

const filePath = '/Users/akruthika/Downloads/AVN 2029 DATA BASE.xlsx';
const buf = fs.readFileSync(filePath);
const wb = XLSX.read(buf, { type: 'buffer' });

const formWs = wb.Sheets['Form Responses 1'];
const formRows = XLSX.utils.sheet_to_json(formWs, { header: 1, defval: '' });

const invalidPhones = [
  { name: 'D. Samarth', phone: '6303550661' },
  { name: 'Pandula Manisha', phone: '6302131449' },
  { name: 'Harshitha', phone: '9490991171' },
  { name: 'Hasini Ketha', phone: '9346136182' },
  { name: 'K.Rithika', phone: '6281591426' },
  { name: 'Srivanigorige', phone: '7989114007' },
  { name: 'Battini Avinash', phone: '7780386670' },
  { name: 'Pollampally Sri Harshith', phone: '9102747955' }
];

console.log('Searching Form Responses 1 for the 8 students with invalid emails in batch tabs:');
invalidPhones.forEach(inv => {
  const matches = [];
  for (let i = 1; i < formRows.length; i++) {
    const r = formRows[i];
    const phone = String(r[5] || '').replace(/[^0-9]/g, '');
    if (phone === inv.phone) {
      matches.push({ row: i + 1, name: r[1], email: r[4], phone: r[5], timestamp: r[0] });
    }
  }
  console.log(`\n${inv.name} (Phone: ${inv.phone}): Found ${matches.length} matching rows in Form Responses 1:`);
  matches.forEach(m => console.log(`  - Row ${m.row}: Name="${m.name}", Email="${m.email}", Phone="${m.phone}"`));
});
