// An ordinary web app: it knows nothing of the arcade. Its server is wherever
// it was deployed; here, the arcade's host phone.
const API = "http://localhost:8000";
const $ = (id) => document.getElementById(id);
const room = new URLSearchParams(window.location.search).get("room");

fetch(`${API}/hello`).then((r) => r.json()).then((d) => ($("hello").textContent = d.text));

if (room) {
	$("room").textContent = `room ${room}`;
	setInterval(async () => {
		const r = await fetch(`${API}/state?room=${room}`);
		if (r.ok) $("count").textContent = String((await r.json()).count);
	}, 300);
}
$("new").onclick = async () => {
	const { id } = await (await fetch(`${API}/rooms`, { method: "POST" })).json();
	const next = new URL(window.location.href);
	next.searchParams.set("room", id);
	window.location.href = next.toString();
};
$("click").onclick = () =>
	fetch(`${API}/click`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room }) });
$("rules").onclick = () => window.open("/rules.html", "_blank", "noopener");
window.leak = () => fetch(`${API}/leak`).then((r) => r.json());
