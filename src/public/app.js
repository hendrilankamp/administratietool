// Kleine verbeteringen voor formulieren. Alles werkt ook zonder JavaScript (behalve regels toevoegen en live totalen).
(function () {
  "use strict";

  // Bevestiging bij gevaarlijke acties: <form data-bevestig="Weet je het zeker?">
  document.addEventListener("submit", function (e) {
    var form = e.target;
    var vraag = form.getAttribute("data-bevestig");
    if (vraag && !window.confirm(vraag)) e.preventDefault();
  });

  // Bedragen parsen zoals de server (Nederlandse notatie)
  function parseBedrag(s) {
    if (!s) return 0;
    s = String(s).replace(/[€\s]/g, "");
    var neg = s.indexOf("-") === 0;
    s = s.replace(/^[-+]/, "");
    var k = s.lastIndexOf(","), p = s.lastIndexOf(".");
    var dec = k >= 0 && p >= 0 ? (k > p ? "," : ".") : k >= 0 ? "," : p >= 0 && s.length - p - 1 !== 3 ? "." : ",";
    s = dec === "," ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    var n = Math.round(parseFloat(s) * 100);
    if (isNaN(n)) return 0;
    return neg ? -n : n;
  }
  function fmt(c) {
    return (c / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Factuurregels: toevoegen, verwijderen en totalen berekenen
  var tabel = document.querySelector("table.regels[data-bewerkbaar]");
  if (tabel) {
    var tbody = tabel.querySelector("tbody");
    var sjabloon = document.getElementById("regel-sjabloon");
    var tarieven = JSON.parse(tabel.getAttribute("data-tarieven") || "{}");

    function hernummer() {
      Array.prototype.forEach.call(tbody.querySelectorAll("tr"), function (tr, i) {
        Array.prototype.forEach.call(tr.querySelectorAll("[data-naam]"), function (el) {
          el.name = "regels[" + i + "][" + el.getAttribute("data-naam") + "]";
        });
      });
    }
    function bereken() {
      var excl = 0, btw = 0;
      Array.prototype.forEach.call(tbody.querySelectorAll("tr"), function (tr) {
        var e = parseBedrag(tr.querySelector('[data-naam="bedrag_excl"]').value);
        var code = tr.querySelector('[data-naam="btw_code"]').value;
        var t = tarieven[code] || { bp: 0, verlegd: false };
        var veldBtw = tr.querySelector('[data-naam="btw_bedrag"]');
        var b;
        if (t.verlegd || t.bp === 0) { b = 0; veldBtw.placeholder = "0,00"; }
        else {
          var auto = Math.round((e * t.bp) / 10000);
          veldBtw.placeholder = fmt(auto);
          b = veldBtw.value.trim() === "" ? auto : parseBedrag(veldBtw.value);
        }
        excl += e; btw += b;
      });
      var z = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = fmt(v); };
      z("tot-excl", excl); z("tot-btw", btw); z("tot-incl", excl + btw);
    }
    tabel.addEventListener("input", bereken);
    tabel.addEventListener("change", bereken);
    tabel.addEventListener("click", function (e) {
      if (e.target.matches("[data-verwijder-regel]")) {
        e.preventDefault();
        e.target.closest("tr").remove();
        hernummer(); bereken();
      }
    });
    var toevoegen = document.querySelector("[data-regel-toevoegen]");
    if (toevoegen && sjabloon) {
      toevoegen.addEventListener("click", function (e) {
        e.preventDefault();
        tbody.appendChild(sjabloon.content.cloneNode(true));
        hernummer(); bereken();
      });
    }
    // Categorie met standaard BTW-code: vul de BTW-code voor als die nog niet is gekozen
    tabel.addEventListener("change", function (e) {
      if (e.target.matches('[data-naam="categorie_id"]')) {
        var opt = e.target.selectedOptions[0];
        var code = opt && opt.getAttribute("data-btw");
        var sel = e.target.closest("tr").querySelector('[data-naam="btw_code"]');
        if (code && sel && sel.getAttribute("data-handmatig") !== "1") { sel.value = code; bereken(); }
      }
      if (e.target.matches('[data-naam="btw_code"]')) e.target.setAttribute("data-handmatig", "1");
    });
    hernummer(); bereken();
  }

  // Leverancier kiezen: standaardcategorie invullen op lege regels
  var relSel = document.querySelector("select[data-relatie-select]");
  if (relSel && tabel) {
    relSel.addEventListener("change", function () {
      var opt = relSel.selectedOptions[0];
      var cat = opt && opt.getAttribute("data-categorie");
      if (!cat) return;
      Array.prototype.forEach.call(tabel.querySelectorAll('[data-naam="categorie_id"]'), function (s) {
        if (!s.value) { s.value = cat; s.dispatchEvent(new Event("change", { bubbles: true })); }
      });
    });
  }

  // Slepen en neerzetten van bestanden op de upload-zone
  Array.prototype.forEach.call(document.querySelectorAll(".dropzone"), function (zone) {
    var input = zone.querySelector("input[type=file]");
    ["dragenter", "dragover"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove("over"); });
    });
    zone.addEventListener("drop", function (e) {
      if (input && e.dataTransfer && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        var naam = zone.querySelector("[data-bestanden]");
        if (naam) naam.textContent = e.dataTransfer.files.length + " bestand(en) gekozen";
      }
    });
  });

  // Pagina automatisch vernieuwen zolang er iets op de achtergrond loopt (AI-uitlezen, Outlook-koppeling)
  var vernieuw = document.querySelector("[data-vernieuw]");
  if (vernieuw) {
    var sec = parseInt(vernieuw.getAttribute("data-vernieuw"), 10) || 5;
    setTimeout(function () {
      var bezig = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
      if (!bezig) window.location.reload();
    }, sec * 1000);
  }

  // Hele tabelrij klikbaar (behalve op invoervelden, knoppen en links zelf)
  document.addEventListener("click", function (e) {
    var tr = e.target.closest && e.target.closest("tr[data-href]");
    if (!tr || e.target.closest("a, button, input, select, label, textarea")) return;
    if (window.getSelection && String(window.getSelection())) return; // tekst selecteren blijft mogelijk
    window.location.href = tr.getAttribute("data-href");
  });

  // "Alles selecteren"-vinkje
  Array.prototype.forEach.call(document.querySelectorAll("[data-alles-selecteren]"), function (alle) {
    alle.addEventListener("change", function () {
      var tabel = alle.closest("table");
      Array.prototype.forEach.call(tabel.querySelectorAll('tbody input[type="checkbox"]'), function (c) { c.checked = alle.checked; });
    });
  });

  // Bedragmodus in de CSV-mapping
  var modus = document.querySelector("select[name=bedragModus]");
  if (modus) {
    var toon = function () {
      Array.prototype.forEach.call(document.querySelectorAll("[data-modus]"), function (el) {
        el.classList.toggle("verborgen", el.getAttribute("data-modus").split(" ").indexOf(modus.value) < 0);
      });
    };
    modus.addEventListener("change", toon);
    toon();
  }
})();
