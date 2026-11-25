const geo=require('./geo');
function start(page){
 stop(page);page._position=p=>{if(page._visible===false)return;page.setData({location:{latitude:p.latitude,longitude:p.longitude,accuracy:p.accuracy||0},locationText:'当前位置已更新'});};
 page._direction=p=>{if(page._visible===false||!Number.isFinite(p.direction))return;const now=Date.now();if(now-(page._headingAt||0)<100)return;page._headingAt=now;page.setData({heading:p.direction,compassReady:true});};
 if(wx.onLocationChange)wx.onLocationChange(page._position);
 if(wx.onCompassChange)wx.onCompassChange(page._direction);
 if(wx.startCompass)wx.startCompass({fail:()=>page.setData({compassReady:false})});
 return geo.locate().then(p=>{page._position(p);if(wx.startLocationUpdate)wx.startLocationUpdate({type:'wgs84',fail:()=>page.setData({locationText:'位置已获取，连续定位暂不可用'})});return p;});
}
function stop(page){if(page._position&&wx.offLocationChange)wx.offLocationChange(page._position);if(page._direction&&wx.offCompassChange)wx.offCompassChange(page._direction);if(page._position&&wx.stopLocationUpdate)wx.stopLocationUpdate({fail:()=>{}});if(page._direction&&wx.stopCompass)wx.stopCompass({fail:()=>{}});page._position=null;page._direction=null;}
module.exports={start,stop};
