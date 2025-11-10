htmlStr = "";

document.querySelectorAll("video").forEach((el) => {
  htmlStr += `<video style="max-width: 300px;margin: 8px; padding: 8px; border: 1px solid lightgray; border-radius: 4px;" src="${el.src}"></video>`;
});

var newWindow = window.open();

newWindow.document.open();
newWindow.document.close();

var doc = newWindow.document;
var html = doc.documentElement;
var body = doc.querySelector("body");
var escapeHTMLPolicy = trustedTypes.createPolicy("forceInner", {
  createHTML: (to_escape) => to_escape,
});
body.innerHTML = escapeHTMLPolicy.createHTML(htmlStr);

html.appendChild(body);
