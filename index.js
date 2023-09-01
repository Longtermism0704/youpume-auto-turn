let btn=document.getElementById('btn');
console.log(btn);

btn.onclick=function(){
    console.log("开启");
    sendMessageToContent({action: 'test', data: '你好，我来自popup！'}, (response) => {
        console.log('来自content的回复:', response)
    })
}
function sendMessageToContent (message, callback) {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
            if (callback) callback(response)
        })
    })
}
