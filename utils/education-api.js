'use strict';
function validate(value){
 const url=String(value||'').trim();
 if(!/^https:\/\/[a-z0-9.-]+(?::443)?\/[^\s#]*$/i.test(url)||url.length>2048)throw new Error('请输入学校提供的完整HTTPS课表API地址，不能填写门户或登录网址');
 if(/\/(?:authserver\/login|new\/ehall\.html)(?:[?\/]|$)/i.test(url))throw new Error('这是登录或门户网页，请填写学校授权的课表数据接口');
 return url;
}
module.exports={validate};
