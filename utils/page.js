function tab(page,index){if(typeof page.getTabBar==='function'){const t=page.getTabBar();if(t)t.setData({selected:index});}}
function toast(error){wx.showToast({title:typeof error==='string'?error:error.message,icon:'none',duration:3000});}
module.exports={tab,toast};
