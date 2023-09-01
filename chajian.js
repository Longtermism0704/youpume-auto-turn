// alert("我是有谱么自动翻谱插件0704");

let initial = 0;

function autoScroll(){
    
    let innerDiv = document.getElementById('nier-scroll-view');
    console.log(innerDiv);
    let height=innerDiv.scrollHeight
    console.log(height);
    
    

    if(initial<=height){
        innerDiv.scrollTop=initial;
        initial=initial+20;
        console.log(initial);
        setTimeout(autoScroll, 2000);
    }else{
        
    }
}

chrome.runtime.onMessage.addListener((request, sender, senderResponse) => {
	if (request.action === 'test') {
		autoScroll();
	}
	senderResponse('我收到了你的消息---来自content')
})




