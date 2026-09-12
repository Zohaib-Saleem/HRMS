import { chromium } from 'playwright';
const BASE='https://hrms.gamempires.com';
const b=await chromium.launch({args:['--no-sandbox']});
const c=await b.newContext({viewport:{width:390,height:844}});
const p=await c.newPage();
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.fill('input[type="email"]','admin@hrms.local');
await p.fill('input[type="password"]',process.env.ADMIN_PASSWORD);
await Promise.all([p.waitForURL(u=>!u.pathname.startsWith('/login'),{timeout:25000}),p.click('button[type="submit"]')]);
await p.waitForLoadState('networkidle');
await p.waitForTimeout(1500);
const out=await p.evaluate(()=>{
  const vw=document.documentElement.clientWidth;
  const bad=[];
  document.querySelectorAll('*').forEach(el=>{
    const r=el.getBoundingClientRect();
    if(r.right>vw+1&&r.width>0){
      bad.push({tag:el.tagName,cls:(el.className&&el.className.toString().slice(0,90))||'',right:Math.round(r.right),w:Math.round(r.width),text:(el.textContent||'').trim().slice(0,50)});
    }
  });
  return {vw,scrollW:document.documentElement.scrollWidth,count:bad.length,worst:bad.slice(0,12)};
});
console.log(JSON.stringify(out,null,1));
await b.close();
