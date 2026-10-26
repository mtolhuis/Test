# Portfolio-app voor iPhone

Een app om uit je eigen foto's één of meer portfolio's samen te stellen en te bekijken.
Het is een web-app (PWA): je zet hem via Safari op je beginscherm en daarna opent hij
schermvullend als een gewone app. Er is geen Mac, Xcode of App Store-account nodig.

## Zo werkt de app

De tabbalk onderaan:

| Tabblad | Wat het doet |
|---|---|
| **Portfolio** (eerste) | Je portfolio. Tik op een foto om hem schermvullend te bekijken en veeg naar links of rechts. |
| **Extra portfolio's** | Met **+ Nieuw** voeg je zoveel portfolio's toe als je wilt. Ze verschijnen tussen het eerste en het laatste tabblad. |
| **Foto's** (laatste) | Je fotomap. Tik op **+** om foto's uit je iPhone-fotobibliotheek toe te voegen. Kies bovenaan bij **Voor:** een portfolio en tik op foto's om ze te selecteren of te deselecteren. Het nummer geeft de volgorde in het portfolio aan. |

Via de knop **⋯** in een portfolio kun je:
- de naam wijzigen
- kiezen tussen een lijst (grote foto's onder elkaar) en een raster
- de volgorde aanpassen of foto's uit het portfolio halen
- het portfolio verwijderen (de foto's zelf blijven bewaard)

Via **⋯** in **Foto's** verwijder je foto's helemaal uit de app.

## Op je iPhone zetten

1. Zet de app online met GitHub Pages: ga in deze repository naar
   **Settings → Pages** en kies bij *Source* **GitHub Actions**.
   De workflow in `.github/workflows/pages.yml` publiceert de app daarna bij elke push
   (vanaf de standaard-branch). Het adres staat daarna in **Settings → Pages**,
   meestal `https://<gebruikersnaam>.github.io/<repository>/`.
   (GitHub Pages voor een *privé*-repository vereist een betaald GitHub-abonnement.
   Elke andere statische hosting, bijvoorbeeld Netlify, werkt ook.)
2. Open dat adres in **Safari** op je iPhone.
3. Tik op de deelknop (vierkant met pijl) → **Zet op beginscherm** → **Voeg toe**.
4. Open de app voortaan via het icoon op je beginscherm.

## Goed om te weten

- Foto's worden alleen **op je iPhone** bewaard, binnen de app. Er wordt niets geüpload.
- Bij het toevoegen wordt een kopie gemaakt van maximaal 2048 pixels (plus een kleine
  miniatuur). De originelen in je fotobibliotheek blijven onaangeroerd.
- Verwijder je het app-icoon van je beginscherm, dan verdwijnen ook de foto's en
  portfolio's in de app.
- De app werkt ook zonder internet, nadat je hem één keer hebt geopend.

## Bestanden

- `index.html`, `styles.css`, `app.js`: de app zelf
- `sw.js`: zorgt dat de app offline werkt
- `manifest.webmanifest`, `icons/`: naam en icoon op het beginscherm
