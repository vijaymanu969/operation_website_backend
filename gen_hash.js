const bcrypt = require('bcryptjs');
bcrypt.hash('changeme', 10).then(h => {
  console.log(h);
  process.exit(0);
});
