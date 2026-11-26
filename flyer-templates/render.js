const {chromium}=require('playwright-core');
(async()=>{const [f,w,h]=process.argv.slice(2);const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'});
const p=await b.newPage({viewport:{width:+w,height:+h}});
await p.goto('file://'+__dirname+'/'+f);await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(300);
await p.screenshot({path:__dirname+'/'+f.replace('.html','.png')});await b.close();})();
