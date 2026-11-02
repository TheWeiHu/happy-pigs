const {mkdirSync,copyFileSync}=require('node:fs');
mkdirSync('dist',{recursive:true});
for(const file of ['index.html','game-core.js','online.js']) copyFileSync(file,`dist/${file}`);
