# Release: Chrome Web Store

Stand: 19 oktober 2026, versie **1.6.6**.

**Status: pakket klaar, nog niet ingediend.** Het ontwikkelaarsaccount bestaat
en de registratie is betaald. Er is nog niets geüpload of gepubliceerd.
Uploaden, indienen en goedkeuren zijn drie aparte stappen. Elke stap zie je
pas in het dashboard.

## 1. Wat jij nu doet

Alles in het [Developer Dashboard](https://chrome.google.com/webstore/devconsole).

### a. Account (één keer)

1. **Tweestapsverificatie** aanzetten op het Google-account van het dashboard
   (myaccount.google.com → Beveiliging). Zonder kun je niet publiceren.
2. Tabblad **Account**: vul een **contact-e-mailadres** in en klik op de
   bevestigingslink in je mail. Zonder bevestigd adres kun je niet indienen.
3. **Handelaarsstatus:** kies *niet-handelaar* zolang je er niets aan
   verdient. Je kunt dat later wijzigen.

### b. Upload

4. **Nieuw item** → upload `cart-saver-1.6.6.zip`. Die heb je van mij
   gekregen, of je maakt hem zelf met `npm run package` (komt in `dist/`).
5. **Nodig voor sync tussen je ZIP-installaties:** tabblad **Pakket** →
   *Openbare sleutel weergeven*. Stuur mij de sleutel (alleen de tekst
   tussen de BEGIN- en END-regels). Die is openbaar, dus je mag hem gewoon
   delen; de privésleutel komt nooit in beeld. Dan krijgt elke ZIP-installatie
   hetzelfde ID als de Store-versie. Voor publiceren is dit niet nodig. Zie
   *Sync tussen je eigen computers* hieronder.

### c. Store-vermelding

6. Vul de teksten uit **§3** in, in het Nederlands en het Engels
   (taal kiezen bovenaan het formulier).
7. Upload het icoon en de afbeeldingen uit `docs/store/` (Nederlands) en
   `docs/store/en/` (Engels).
8. Categorie: **Shopping** (Winkelen). In de huidige indeling valt die onder
   *Lifestyle*. Controleer dat in het formulier.

### d. Privacy

9. Vul het tabblad **Privacypraktijken** in met **§4**.
10. Privacybeleid-URL:
    <https://github.com/MilanVeenstra/CartSaver/blob/main/PRIVACY.md>

### e. Testgegevens voor de beoordelaar

11. Cart Saver doet niets zonder Cardmarket-account, en een beoordelaar maakt
    er zelf meestal geen aan. Maak daarom een **apart Cardmarket-account**
    alleen hiervoor, niet je eigen. Vul gebruikersnaam en wachtwoord in bij
    de testgegevens van het tabblad *Privacy* / *Testinstructies*, nooit in
    de beschrijving.
12. Plak de tekst uit **§5** in de testinstructies.

### f. Distributie en indienen

13. **Distributie:** openbaar, gratis, alle regio's (of alleen Europa).
14. Klik op **Indienen voor beoordeling**. Dat duurt meestal een paar dagen,
    soms langer. Je krijgt een mail.

**Bestaande ZIP-gebruikers (jijzelf):** de Store-versie is een andere
installatie met een eigen ID en eigen opslag. Exporteer vóór je overstapt je
gegevens (Instellingen → Gegevens → Exporteren), verwijder de ZIP-versie,
installeer de Store-versie en importeer het bestand. Met synchroniseren aan
nemen je andere browsers het daarna over.

**Sync tussen je eigen computers (ZIP).** Chrome bewaart de sync per
extensie-ID. Een uitgepakte installatie zonder vaste `key` krijgt een ID uit
het pad van de map, dus elke computer heeft een ander ID en de sync komt
nooit bij elkaar. Je ziet het in Instellingen → *Je andere browsers*: de
ID's verschillen en er staat *nog nooit iets ontvangen*. Zo los je het op:

1. Stuur de openbare sleutel uit stap 5. Ik zet hem als `key` in
   `manifest.json` (`package.sh` haalt hem weer weg voor de Store).
2. **Vóór die versie binnenkomt, op elke computer:** Instellingen →
   Gegevens → *Exporteren*, en schrijf je instellingen op. Met een nieuw ID
   begint de extensie leeg (de oude gegevens blijven onder het oude ID).
3. Laat de nieuwe versie binnenkomen (automatisch of met ↻). Controleer dat
   beide computers nu hetzelfde ID tonen.
4. Computer A: *Importeren*, instellingen terugzetten, *Nu synchroniseren*.
5. Computer B: eerst *Nu synchroniseren* (neemt A over), dan *Importeren*
   (voegt alleen toe wat ontbreekt), dan nog eens *Nu synchroniseren*.
6. In Chrome op beide computers: ingelogd in Chrome zelf met hetzelfde
   Google-account, en bij *Synchronisatie beheren* staat **Extensies** aan.
   `chrome://sync-internals` laat zien of *Extension Settings* loopt.
7. Verwijder de extensie liever niet op één computer terwijl de andere synct
   (gebruik *Opnieuw laden*): Chrome wist dan de kopie in je account. Sinds
   1.6.9 gooit Cart Saver daardoor niets meer weg, maar exports zijn nooit
   verkeerd.

## 2. Pakket

- **Bouwen:** `npm run package` (`scripts/package.sh`)
- **Inhoud:** alleen `manifest.json`, `_locales/`, `icons/` en `src/`, met
  `manifest.json` in de root. Tests, docs, scripts, `build-id.txt` en sleutels
  gaan niet mee.
- **Bestand:** `dist/cart-saver-1.6.6.zip`
- **SHA-256:** zie het einde van dit document (§7)
- **Reproduceerbaar:** twee keer bouwen geeft dezelfde digest (vaste datums
  en volgorde).

### Wat er voor de Store veranderde (1.6.6)

| Wat | Waarom |
|---|---|
| Naam **Cart Saver for Cardmarket** | Een naam die met het merk van een ander begint, lijkt officieel. "for …" is de gebruikelijke vorm. |
| De prijsgids en PokemonPriceTracker zijn **optionele** sitetoestemmingen | Bij installeren ziet een gebruiker alleen Cardmarket. Chrome vraagt de andere website pas als je de functie aanzet. |
| De PokemonPriceTracker-sleutel gaat **niet meer mee met de sync** | Het is een soort wachtwoord. Hij blijft in de browser waarin je hem invult. |
| **Alles wissen** wist echt alles | Ook gebruikersnaam, API-sleutel, plaatjes, prijzen, instellingen en de kopie in de sync. |
| Het paginascript kijkt alleen naar verzoeken aan cardmarket.com | Verzoeken naar andere websites laat het met rust. |
| Berichten aan de achtergrond worden op afzender gecontroleerd | Een website kan je API-tegoed niet opmaken en geen meldingen sturen. |
| Links uit de sync worden gecontroleerd | Alleen https-links naar Cardmarket worden overgenomen. |
| Store-icoon met 16 px rand | Richtlijn van de Store: 96×96 tekening op 128×128. |
| `homepage_url` in het manifest | Link naar de GitHub-pagina. |
| **Taalknop** NL/EN | In de popup (NL / EN) en in de instellingen (Automatisch / Nederlands / English). |

### Gecontroleerd

| Controle | Resultaat |
|---|---|
| Testsuite (`npm test`) | 132/132 groen, ook in GitHub Actions bij elke push |
| Vertalingen | Test: dezelfde sleutels in beide talen, dezelfde `$1…$9`, geen lege of onvertaalde teksten, en elke sleutel die de code gebruikt bestaat |
| Optionele toestemmingen | Test met het echte manifest: een verse installatie mag alleen Cardmarket bereiken. Staat een functie via de sync aan zonder toestemming, dan gaat er geen verzoek de deur uit en vraagt de instellingenpagina erom. |
| Externe of dynamische code | Geen `eval`, `new Function`, timers met tekst of externe scripts |
| Geen sleutels of lokale bestanden in de ZIP | Gecontroleerd door het script |
| Herladen bij ontwikkelen | Alleen bij een uitgepakte map (`installType === 'development'`). Er wordt niets gedownload. Een Store-installatie werkt via de Store bij. |

### Niet getest (kan hier niet)

- De automatische controle van het dashboard en de beoordeling door Google.
- Het echte cardmarket.com: dat is vanuit de ontwikkelomgeving geblokkeerd.
  Alles is getest tegen een nagebootste Cardmarket. Test zelf na installatie
  één keer met je eigen account.
- Sync tussen twee echte computers.
- De PSA-koppeling met een echte PokemonPriceTracker-sleutel.
- Chromes toestemmingsvraag zelf (een test kan daar niet op klikken).

## 3. Listing

**Naam (uit het manifest):** `Cart Saver for Cardmarket`

**Categorie:** Shopping · **Talen:** Nederlands, Engels

**Korte beschrijving** (uit het manifest, max. 132 tekens):
- NL: Onthoudt wat je in je Cardmarket-winkelmandje legt en zet het met één klik terug nadat je mandje is geleegd.
- EN: Remembers what you put in your Cardmarket shopping cart and puts it back with one click after the cart was emptied.

### Uitgebreide beschrijving (NL)

> Wie op Cardmarket een deck bij elkaar zoekt, legt vaak tientallen kaarten van verschillende verkopers in zijn mandje, in precies de goede conditie en taal. Cardmarket leegt dat mandje vanzelf: na verloop van tijd, als een verkoper op vakantie gaat of als iets verkocht wordt. Cart Saver onthoudt alles wat je in je mandje legt en zet het met één klik terug, zolang het nog te koop is.
>
> • Automatisch onthouden: kaart of product, verkoper, conditie, taal, prijs en aantal.
> • Eén klik terug: één verzoek per verkoper, alleen wat echt ontbreekt. Met Ongedaan maken.
> • Weten wat er gebeurde: mandje geleegd, verkoper verdwenen, verkocht of duurder geworden.
> • Vervanging voor verkochte kaarten: bij dezelfde verkoper, bij een verkoper die al in je mandje zit, of de goedkoopste.
> • Alle spellen in één mandje: Magic, Pokémon, Yu-Gi-Oh!, One Piece, Lorcana en meer.
> • Favorieten en eigen lijsten, om later in één keer in je mandje te zetten.
> • Negeren wat weg is, zodat een verdwenen aanbieding geen melding meer geeft.
> • In al je browsers hetzelfde, via de sync van je eigen browser-account.
> • In het Nederlands of het Engels, met één klik te wisselen.
> • Optioneel: geschatte PSA-waarde voor Pokémon-kaarten (met je eigen PokemonPriceTracker-sleutel) en prijzen vergeleken met de trend.
>
> Privacy: je gegevens blijven in je eigen browser en in de sync van je eigen browser-account. Er is geen server en er is geen tracking. Cart Saver praat met cardmarket.com via je eigen sessie, en voegt alleen iets toe aan je mandje als jij erop klikt. Alleen als je de PSA-schatting aanzet, gaan de naam en het nummer van een kaart naar PokemonPriceTracker.
>
> Cart Saver is onofficieel en niet verbonden aan Cardmarket.

### Detailed description (EN)

> If you put a deck together on Cardmarket, you often have dozens of cards from different sellers in your cart, in exactly the right condition and language. Cardmarket empties that cart by itself: after a while, when a seller goes on vacation, or when something is sold. Cart Saver remembers everything you put in your cart and puts it back with one click, as long as it is still for sale.
>
> • Remembered automatically: card or product, seller, condition, language, price and quantity.
> • One click back: one request per seller, only what is really missing. With Undo.
> • Know what happened: cart emptied, seller gone, sold or more expensive.
> • Replacements for sold cards: from the same seller, from a seller already in your cart, or the cheapest one.
> • All games in one cart: Magic, Pokémon, Yu-Gi-Oh!, One Piece, Lorcana and more.
> • Favourites and your own lists, to put in your cart in one go later.
> • Ignore what is gone, so a vanished offer stops reminding you.
> • The same in all your browsers, through your own browser account's sync.
> • In English or Dutch, switched with one click.
> • Optional: estimated PSA value for Pokémon cards (with your own PokemonPriceTracker key) and prices compared with the trend.
>
> Privacy: your data stays in your own browser and your own browser account's sync. No server, no tracking. Cart Saver talks to cardmarket.com through your own session, and only adds to your cart when you click. Only if you switch on the PSA estimate, a card's name and number go to PokemonPriceTracker.
>
> Cart Saver is unofficial and not affiliated with Cardmarket.

### Afbeeldingen

| Bestand (`docs/store/`, Engels in `docs/store/en/`) | Formaat | Inhoud |
|---|---|---|
| `screenshot-01-…` | 1280×800 | Popup met wat terug kan, en de melding op Cardmarket |
| `screenshot-02-…` | 1280×800 | Paneel op de mandjepagina, per verkoper |
| `screenshot-03-…` | 1280×800 | Resultaat met een verkochte kaart, en de vervangingen |
| `screenshot-04-…` | 1280×800 | Favorieten en bewaarde lijsten |
| `screenshot-05-…` | 1280×800 | Geschatte PSA-waarde |
| `promo-tile-440x280.png` | 440×280 | Kleine promotegel |
| `icons/icon128.png` | 128×128 | Store-icoon (96×96 tekening, 16 px rand) |

Op de screenshots staan echte schermen van de extensie, gemaakt tegen de
nagebootste Cardmarket uit de tests. Controleer de eisen aan de afbeeldingen
in het dashboard zelf, want die veranderen weleens.

### Links

- Privacybeleid: <https://github.com/MilanVeenstra/CartSaver/blob/main/PRIVACY.md>
- Startpagina en ondersteuning: <https://github.com/MilanVeenstra/CartSaver>
  (vragen via Issues)

## 4. Privacy (tabblad Privacypraktijken)

**Enkel doel:**
> Keep and restore the user's Cardmarket shopping cart: remember the articles in the cart, favourites and saved lists, and put them back in the cart when the user asks, with optional price information for the saved cards.

(NL: Het Cardmarket-winkelmandje van de gebruiker onthouden en terugzetten:
de artikelen in het mandje, favorieten en bewaarde lijsten bewaren en op
verzoek weer in het mandje zetten, met optionele prijsinformatie bij de
opgeslagen kaarten.)

**Uitleg per toestemming:**

| Toestemming | Waarom |
|---|---|
| `storage` | Saved articles, favourites, lists and settings, in the browser and through the user's own browser sync. |
| `unlimitedStorage` | Small copies of product pictures and large lists can exceed the default local storage quota. |
| `alarms` | Daily clean-up, the optional price guide, a reminder 5 minutes before Cardmarket empties the cart, and the optional check while the user is away. |
| `notifications` | Tell the user that saved articles fell out of the cart while they were on another tab, and before Cardmarket empties the cart. Can be switched off. |
| `idle` | The optional "check the cart while you are away from Cardmarket" only runs while the user is at the computer. Off by default. |
| `declarativeNetRequestWithHostAccess` | One rule that gives the extension's own requests to Cardmarket's picture server a cardmarket.com Referer; the server refuses them otherwise. Requests from web pages are left alone. |
| Host `https://www.cardmarket.com/*` | Read the cart, product, seller and order pages, and on the user's click put articles back with the same requests as the site's own buttons. |
| Host `https://product-images.s3.cardmarket.com/*` | Product pictures in the popup. |
| Optional host `https://downloads.s3.cardmarket.com/*` | Only when the user switches on "Compare prices with the trend": Cardmarket's public price guide. Asked at that moment. |
| Optional host `https://www.pokemonpricetracker.com/*` | Only when the user switches on "Estimated PSA value": graded prices, with the user's own API key. Asked at that moment. |

**Externe code (remote code):** Nee. Alle code zit in het pakket. Er worden
alleen gegevens opgehaald (JSON en HTML-pagina's), nooit code.

**Gegevensgebruik.** Kruis het volgende aan. Liever te veel dan te weinig
aangeven: te weinig is een reden voor afwijzing.

| Categorie | Aankruisen | Toelichting |
|---|---|---|
| Persoonlijk identificeerbare informatie | Ja | Alleen de Cardmarket-gebruikersnaam, lokaal, om accounts niet te verwarren. Gaat niet naar ons. |
| Verificatiegegevens (authentication information) | Ja | Alleen de optionele PokemonPriceTracker-API-sleutel die de gebruiker zelf invult. Blijft in die browser en gaat alleen naar PokemonPriceTracker. De CSRF-code van de Cardmarket-sessie wordt alleen in het geheugen gebruikt en nooit opgeslagen. |
| Gebruikersactiviteit (user activity) | Ja | Op cardmarket.com kijkt de extensie, lokaal, naar de verzoeken van de site zelf en naar klikken op knoppen van het mandje, om te herkennen dat de gebruiker zelf iets weghaalde. Niets wordt opgeslagen of verstuurd. |
| Website-inhoud | Ja | De artikelen in het mandje, favorieten en lijsten worden lokaal en via de sync van het eigen browser-account bewaard. Bij de optionele PSA-schatting gaan de naam en het nummer van een kaart naar PokemonPriceTracker. |
| Financiële gegevens, gezondheid, communicatie, locatie, webgeschiedenis | Nee | |

Verklaringen (alle drie aanvinken): gegevens worden niet verkocht of
doorgegeven buiten de toegestane gevallen, niet gebruikt voor iets anders dan
het enkele doel, en niet voor kredietwaardigheid of leningen.

## 5. Voor de beoordelaar (testinstructies)

> Cart Saver works on www.cardmarket.com and needs a Cardmarket account; test credentials are in the credentials fields. 1) Log in on cardmarket.com and put any article in the shopping cart (any card, any seller). 2) Open the shopping cart page: the Cart Saver panel (bottom right) says the articles are saved. 3) Remove the article with the site's own trash button: Cart Saver forgets it (you removed it yourself). 4) Put an article in the cart again, then take it out from another browser or let Cardmarket empty the cart: on any Cardmarket page a reminder offers "Put 1 back in your cart". 5) The toolbar popup shows the same list, favourites (☆ next to any offer) and saved lists; NL / EN in its header switches the language. Optional features are off by default (settings page); the price guide and PSA estimate ask for permission for their website when switched on.

Geef nooit inloggegevens in deze tekst. Gebruik het aparte veld voor
testgegevens.

## 6. Na het indienen

- Een update gaat opnieuw door de beoordeling. Terugdraaien kan alleen met
  een nieuwe, ook weer beoordeelde versie.
- Nieuwe versies gaan automatisch naar de Store, zie §6a. Met de hand kan
  het nog steeds: `manifest.json`-versie ophogen, `npm test`,
  `npm run package`, uploaden.
- Ondersteuning via GitHub Issues.

## 6a. Automatisch publiceren (GitHub Actions)

`.github/workflows/release.yml` doet bij elke push naar `main`:

1. **Alle tests** draaien (`npm test`) en het pakket bouwen. Rood is stop.
2. **Is de versie in `manifest.json` nieuw?** Nieuw betekent: er is nog
   geen git-tag `v<versie>`. Dan bouwt hij de ZIP, uploadt die naar de Store
   en dient hem in voor review (`scripts/publish.mjs`, Chrome Web Store
   API v2).
3. **GitHub-release:** daarna maakt hij een release `v<versie>` met de ZIP
   en de commits sinds de vorige release.

| Situatie | Wat er gebeurt |
|---|---|
| Push met een hoger versienummer | Tests, upload, indienen voor review, GitHub-release |
| Push zonder nieuw versienummer | Alleen tests. Veranderde de extensie toch, dan staat er een waarschuwing in de run. |
| Er ligt nog een versie in review | De nieuwe versie wacht. Elke ochtend probeert de workflow het opnieuw en dient hem in zodra de vorige review klaar is. |
| Een versie is afgewezen | De run wordt rood met de melding. Je krijgt ook een mail. Repareren, versie ophogen, pushen. |
| De geheimen zijn nog niet ingesteld | Alleen tests. Er wordt niets geüpload. |

Na de review zet Google de versie zelf live. Gebruikers krijgen de update
vanzelf, meestal binnen een paar uur.

### Eenmalig instellen

Doe dit **na je eerste handmatige indiening**. De Store laat de API pas
publiceren als je het item één keer zelf hebt gepubliceerd.

1. **Google Cloud** ([console.cloud.google.com](https://console.cloud.google.com)):
   - Maak een project aan, bijvoorbeeld "cart-saver-release".
   - Ga naar *APIs en services* → *Bibliotheek*, zoek **Chrome Web Store
     API** en klik op *Inschakelen*.
2. **Service-account:** *IAM en beheer* → *Service-accounts* →
   *Service-account maken*, bijvoorbeeld "release". Rollen zijn niet nodig.
   Open het account en ga naar *Sleutels* → *Sleutel toevoegen* → *Nieuwe
   sleutel* → **JSON**. Er wordt een bestand gedownload. Bewaar dat
   **niet** in de projectmap en stuur het naar niemand, ook niet naar mij.
3. **Developer Dashboard** → *Account*: voeg het e-mailadres van het
   service-account toe (eindigt op `iam.gserviceaccount.com`) bij de
   service-accounts voor API-toegang. Noteer daar ook je **publisher-ID**.
   Die staat ook in de adresbalk van het dashboard:
   `…/devconsole/<publisher-ID>/…`.
4. **Item-ID:** de 32 letters van de extensie (a–p), te zien bij het item in
   het dashboard en in de Store-link.
5. **GitHub** → repository → *Settings* → *Secrets and variables* →
   *Actions* → *New repository secret*. Maak er drie:
   - `CWS_SERVICE_ACCOUNT`: de hele inhoud van het JSON-bestand.
   - `CWS_PUBLISHER_ID`: het publisher-ID.
   - `CWS_ITEM_ID`: het item-ID.

   Verwijder daarna het JSON-bestand van je computer. Is het ooit
   uitgelekt, verwijder dan de sleutel in Google Cloud en maak een nieuwe.
6. **Proberen:** GitHub → *Actions* → *Test and release* → *Run workflow*.
   Staat de huidige versie al in de Store, dan meldt de run "already
   submitted" of "already live" en maakt hij de GitHub-release.

De geheimen zijn alleen zichtbaar voor de release-stap op `main`, niet voor
pull requests of forks. Het script gebruikt geen pakketten van anderen:
alleen Node en de officiële API van Google.

## 7. Deze versie

- **Bestand:** `dist/cart-saver-1.6.6.zip` (28 bestanden, ~135 KB)
- **SHA-256:** `fc0c61aa6295298dfd74ac33400b0406e70529da29c3324a8fbb70b9da7304d1`
- **Testsuite:** 132 van 132 groen. De testbrowser kan het echte
  cardmarket.com nooit bereiken (`OFFLINE_ARGS` in `tests/browser.mjs`), dus
  de uitkomst is overal hetzelfde: lokaal, hier en in GitHub Actions.
- **Exacte uploadmap** (`dist/extension/`) geladen in Chromium: mandje wordt
  opgeslagen, paneel, popup en instellingen werken, NL/EN wisselt, de
  optionele websites zijn niet toegestaan bij installeren, geen fouten.
- **UI-audit** in het Nederlands en het Engels, licht en donker, smal
  venster: geen fouten of waarschuwingen in de console. Gevonden en
  opgelost: de knop "Nu ophalen" stak op een smal scherm buiten beeld,
  "1 cards" werd "1 card", Engelse tijden zijn 24-uurs.
