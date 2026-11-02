const {defineConfig}=require('@playwright/test');
const os=require('node:os');
const path=require('node:path');
module.exports=defineConfig({
  outputDir:path.join(os.tmpdir(),'happy-pigs-playwright'),
  testDir:'./tests',testMatch:'*.spec.cjs',timeout:120000,workers:1,
  use:{baseURL:'http://127.0.0.1:8788',headless:true,trace:'retain-on-failure'},
  webServer:{command:`npm run build && PORT=8788 HAPPY_PIGS_DATA_DIR="${path.join(os.tmpdir(),'happy-pigs-e2e')}" node --experimental-sqlite server/node.cjs`,
    url:'http://127.0.0.1:8788',reuseExistingServer:false,timeout:60000}
});
