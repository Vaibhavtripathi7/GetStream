

let config = {
    url : "https://www.cricbuzz.com",
    method: "POST",
    headers: {"Content-Type": "Application/json"},
    body: JSON.stringify({"hello": "world"}) 
}

async function executeRequest(config){

    const response = await fetch(config.url, {method:config.method, headers:config.headers, body:config.body}); // request method

    const data = await response.text()
    return{
        status: response.status,
        headers: response.headers,
        body: data
    }
};

executeRequest(config).then(console.log)

module.exports = { executeRequest };