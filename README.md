# ETF Cashflow-Rebalancing Rechner

Web-App-Version des Excel-Rechners: optimierte monatliche Sparraten-Verteilung zur Zielallokation – ohne Verkäufe und ohne zusätzliches Gesamtbudget.

## Funktionen
- Positionen (Name, aktueller Wert, Ziel-Anteil) frei bearbeiten, hinzufügen, entfernen
- Excel-Logik 1:1: Ist-Anteil, Max.-Bestimmung (Wert ÷ Ziel), Differenz (benötigter Cashflow), Neu. Wert, Ziel-Check
- Monatsplan: Sparrate wird jeden Monat so verteilt, dass die Abweichung zum Ziel minimal wird (untergewichtete Positionen zuerst)
- Kennzahlen: Depotwert, benötigter Cashflow, Monate bis Ziel, max. Abweichung
- Diagramme, optionale Rundung auf ganze Euro, CSV-Export, Hell-/Dunkelmodus
- Eingaben werden lokal im Browser gespeichert

## Nutzung
Einfach `index.html` im Browser öffnen – keine Installation, kein Build.

## Veröffentlichen (GitHub Pages)
1. Branch nach `main` mergen.
2. Im Repository unter **Settings → Pages → Source** „GitHub Actions“ wählen.
3. Der Workflow `.github/workflows/pages.yml` deployt die Seite automatisch.

*Keine Anlageberatung.*
