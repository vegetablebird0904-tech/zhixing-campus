
const store=require('./store');
function accept(result){if(!result.authenticated||!result.token||!result.user)throw new Error('登录响应无效');const s=store.read(),buckets=s.accountEvents||{};if(s.account&&s.account.user)buckets[s.account.user.id]=s.events||[];const id=result.user.id;const drafts=(s.events||[]).filter(e=>!e.synced&&!e.accountId);const events=buckets[id]||drafts;require('./preferences').activate(s.endpoint+'|'+id);store.update({account:{token:result.token,user:result.user,expiresAt:result.expiresAt,endpoint:s.endpoint},accountEvents:buckets,events,profile:{name:result.user.name,phone:'',avatar:'',authType:'account',userId:id}});return result.user;}
function clear(){const s=store.read(),buckets=s.accountEvents||{};if(s.account&&s.account.user)buckets[s.account.user.id]=s.events||[];require('./preferences').activate('guest');store.update({account:null,profile:null,events:[],accountEvents:buckets});}
function current(){const s=store.read(),a=s.account;if(!a||a.endpoint!==s.endpoint||new Date(a.expiresAt).getTime()<=Date.now())return null;return a;}
module.exports={accept,clear,current};
