// Ordinary synthetic source projections. Transport injection never uses fetch/DNS.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {Connectors} from '../../core/connectors.mjs';
const epoch = 1791446400000;
let currentTime = epoch;
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [currentTime])); } static now() { return currentTime; } };
const source = 'https://bulletin.example.test/feed';
const item = (n,link=`https://articles.example.test/${n}`) => `<item><title>Story ${n}</title><link>${link}</link><pubDate>Thu, 08 Oct 2026 00:00:00 GMT</pubDate></item>`;
const fixtures = {epoch, source, weather: [], news: [], errors: []};
async function run(kind, settings, responses) {
  const urls = [];
  const connectors = new Connectors({settings},{request: async (url, options, scope) => {
    assert.equal(scope.purpose,'feed'); assert.equal(scope.allowCloud,true); assert.equal(options.redirect,'error');
    urls.push(String(url));
    const response = responses.shift(); assert.ok(response, 'Unexpected request');
    return new Response(response.body, {status:response.status || 200});
  }});
  try { return {value:await connectors[kind](), urls, admittedUrls:urls.map(u=>new URL(u).href)}; }
  catch(error) { return {error:{status:error.status||500,message:error.message}, urls}; }
}
for (const [city,place,data] of [
  ['Asterhaven',{name:'Asterhaven',latitude:12.25,longitude:-34.5},{current:{temperature_2m:18,weather_code:2,apparent_temperature:17},hourly:{time:Array.from({length:60},(_,i)=>`hour-${i}`),temperature_2m:Array.from({length:50},(_,i)=>i),weather_code:[0,1],precipitation_probability:[3,4,5]},daily:{time:['day-1'],sunrise:['sunrise'],sunset:['sunset']}}],
  ["  Aster's Haven! 😀 / & ",{name:'Aster Haven',latitude:0,longitude:1e-7},{current:null,hourly:{time:[],temperature_2m:[1]},daily:null}],
  ['雲の架空街',{name:'雲の架空街',latitude:-0,longitude:23},{}],
  ['No-hourly',{name:'No-hourly',latitude:10,longitude:20},{hourly:{temperature_2m:[1,2]},current:{}}],
  ['Null-hourly',{name:'Null-hourly',latitude:10,longitude:20},{hourly:null}],
]) {
  const responses=[{body:JSON.stringify({results:[place]})},{body:JSON.stringify(data)}];
  fixtures.weather.push({city,place,data,...await run('weather',{allowNetwork:true,weatherCity:city},responses)});
}
for (const [name,xml] of [
 ['rss','<?xml version="1.0"?><rss><channel><title>  Daily &amp; Hourly  </title>'+item(1)+item(2)+'</channel></rss>'],
 ['atom','<feed><title>Atom daily</title><entry><title>First</title><link href="https://articles.example.test/atom?a=1&amp;b=2"/><published>2026-10-08</published></entry><entry><title>Second</title><link href=\'https://articles.example.test/second\'/><updated>today</updated></entry></feed>'],
 ['cdata','<rss><title><![CDATA[  <b>Fictional</b> &amp; &lt;news&gt; &quot;daily&quot; &#39;  ]]></title><ITEM id="1"><TITLE><![CDATA[<i>Story</i>]]></TITLE><LINK>https://ARTICLES.example.test/a b?q=x&amp;y=2#story</LINK><PUBDATE> date </PUBDATE></ITEM></rss>'],
 ['twelve', '<rss><title>First twelve only</title>'+Array.from({length:15},(_,i)=>item(i,i===2?'/relative':`https://articles.example.test/${i}`)).join('')+'</rss>'],
 ['utf16', '<feed><title>'+('語'.repeat(119))+'😀tail</title><entry><title>'+('t'.repeat(239))+'😀tail\ue000</title><link href="https://articles.example.test/unicode"/></entry></feed>'],
 ['empty', '<rss><title> Nothing today </title></rss>'],
 ['updated', '<feed><title>Time</title><entry><title>T</title><link>https://articles.example.test/</link><updated>later</updated></entry></feed>'],
 ['mixed', '<rss><title>Mixed</title><entry><title>A</title><link>https://articles.example.test/a</link></item><itemized>ordinary unrelated content</itemized>'+item(3)+'</rss>'],
 ['whitespace', '<rss><title>\ufeff\u00a0 News \u00a0</title><item\u00a0id="1"><title>\u0085Kept\u0085</title><link>https://articles.example.test/</link></item></rss>'],
]) fixtures.news.push({name,xml,...await run('news',{allowNetwork:true,newsUrl:source},[{body:xml}])});
for (const [name,kind,settings,responses] of [
 ['weather-disabled','weather',{allowNetwork:false,weatherCity:'Asterhaven'},[]],
 ['weather-empty','weather',{allowNetwork:true,weatherCity:''},[]],
 ['weather-space','weather',{allowNetwork:true,weatherCity:'\ufeff\u00a0'},[]],
 ['weather-long','weather',{allowNetwork:true,weatherCity:'😀'.repeat(51)},[]],
 ['weather-not-found','weather',{allowNetwork:true,weatherCity:'Asterhaven'},[{body:'{"results":[]}'}]],
 ['weather-geocode-status','weather',{allowNetwork:true,weatherCity:'Asterhaven'},[{status:503,body:'unavailable'}]],
 ['weather-forecast-status','weather',{allowNetwork:true,weatherCity:'Asterhaven'},[{body:'{"results":[{"name":"Asterhaven","latitude":12,"longitude":34}]}'},{status:503,body:'unavailable'}]],
 ['news-disabled','news',{allowNetwork:false,newsUrl:source},[]],
 ['news-empty','news',{allowNetwork:true,newsUrl:''},[]],
 ['news-status','news',{allowNetwork:true,newsUrl:source},[{status:503,body:'unavailable'}]],
]) fixtures.errors.push({name,kind,settings,responses:structuredClone(responses),...await run(kind,settings,responses)});
// Freeze cache hits, exact TTL expiry, key changes, permission-before-cache,
// and source wall-clock rollback without sleeping or making an external request.
fixtures.cache = [];
const cacheStore = {settings:{allowNetwork:true,weatherCity:'Asterhaven',newsUrl:source}};
let cacheRequests = 0;
const cached = new Connectors(cacheStore,{request:async(url,options,scope)=>{
  assert.equal(scope.purpose,'feed'); cacheRequests++;
  const body = String(url).includes('/v1/search?') ? {results:[{name:cacheStore.settings.weatherCity,latitude:12.25,longitude:-34.5}]} : String(url).includes('/v1/forecast?') ? {current:{temperature_2m:18}} : null;
  return new Response(body ? JSON.stringify(body) : '<rss><title>Cached bulletin</title></rss>');
}});
for (const [kind,offset,patch] of [
 ['weather',0,{}],['weather',899999,{}],['weather',900000,{}],['weather',-1,{}],
 ['weather',900001,{allowNetwork:false}],['weather',900002,{allowNetwork:true,weatherCity:'Second fictional city'}],
 ['news',1000000,{}],['news',1599999,{}],['news',1600000,{}],['news',0,{}],
 ['news',1600001,{allowNetwork:false}],['news',1600002,{allowNetwork:true,newsUrl:'https://bulletin.example.test/other'}],
]) {
  currentTime=epoch+offset;Object.assign(cacheStore.settings,patch);
  const step={kind,at:currentTime,settings:structuredClone(cacheStore.settings)};
  try { step.value=await cached[kind](); } catch(error) {step.error={status:error.status||500,message:error.message};}
  step.requests=cacheRequests;fixtures.cache.push(step);
}
await writeFile(new URL('../../native-service/src/workspace/feed_connectors/source-fixtures.json',import.meta.url),JSON.stringify(fixtures,null,2)+'\n');
console.log(`Frozen ${fixtures.weather.length} weather, ${fixtures.news.length} news and ${fixtures.errors.length} ordinary error cases`);
