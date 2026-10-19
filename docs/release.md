# Release: Chrome Web Store

Stand: 19 oktober 2026, versie **1.6.5**.

**Status: pakket klaar, nog niet ingediend.** Er is niets geüpload of
gepubliceerd. Een geüpload concept, een ingediende versie en een goedgekeurde
versie zijn drie aparte stappen. Elke stap zie je pas in het dashboard.

## 1. Wat jij doet (één keer)

Doel: een vaste extensie-ID, zodat de sync voor iedereen werkt, en later de
Store voor automatische updates.

1. Ga naar het [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   en log in met het Google-account dat eigenaar wordt.
2. Registreer je als ontwikkelaar. De eenmalige registratiekosten staan in het
   dashboard. Controleer daar het bedrag.
3. Klik op **Nieuw item** en upload `dist/cart-saver-1.6.5.zip`. Je maakt hem
   zelf met `npm run package`, of gebruikt de ZIP die je van mij kreeg.
4. **Nog niet indienen.** Open het tabblad **Pakket** en klik op
   **Openbare sleutel weergeven**. Kopieer de sleutel (zonder de regels
   `-----BEGIN/END PUBLIC KEY-----`) en stuur hem naar mij. Deze sleutel is
   openbaar, dus je mag hem gewoon delen.
5. Ik zet die sleutel als `key` in `manifest.json`. Daarna hebben de
   ZIP-installaties en de Store-versie hetzelfde ID. Het uploadpakket zelf
   bevat geen sleutel, want het script haalt hem eruit.
6. Vul de listing in met de teksten hieronder en dien de extensie in als je
   wilt.

**Let op, één keer:** door de vaste sleutel krijgt een bestaande
ZIP-installatie een nieuw ID. Exporteer dus eerst je gegevens
(Instellingen → Gegevens → Exporteren) en importeer ze daarna weer. Na
die ene keer zorgt de sync ervoor.

## 2. Pakket

- **Bouwen:** `npm run package` (`scripts/package.sh`)
- **Inhoud:** alleen `manifest.json`, `_locales/`, `icons/` en `src/`, met
  `manifest.json` in de root. Tests, docs, scripts, `build-id.txt` en sleutels
  gaan niet mee.
- **Bestand:** `dist/cart-saver-1.6.5.zip` (28 bestanden, ~132 KB)
- **SHA-256:** `6d5b97e9e70cc79dcd9d15bba4a24d8094fc619ef7ece91f585eea82e01e7d70`
- **Reproduceerbaar:** twee keer bouwen geeft dezelfde digest (vaste datums
  en volgorde).

### Gecontroleerd

| Controle | Resultaat |
|---|---|
| Testsuite (`npm test`) | 108/109 groen. De enige fout heeft het echte cardmarket.com nodig, dat vanuit de ontwikkelomgeving geblokkeerd is. Hij faalde ook al vóór deze versie. |
| Exacte map `dist/extension/` geladen in Chromium | Service worker start, mandje wordt opgeslagen, paneel, popup en instellingen openen, geen fouten |
| Externe of dynamische code | Geen `eval`, `new Function`, timers met tekst of externe scripts. Het controlescript gaf vals alarm: het zoekt hoofdletterongevoelig naar `Function(` en matcht daardoor elke `function (`. |
| Geen sleutels of lokale bestanden in de ZIP | Gecontroleerd door het script |
| Zelf bijwerken | Alleen bij een uitgepakte installatie (`installType === 'development'`). Een Store-installatie werkt via de Store bij. |

### Nog niet gedaan (pas na je upload of handmatig)

- De automatische controle van het dashboard en de beoordeling door Google.
- Testen met een echt Cardmarket-account in een Store-installatie.
- Sync tussen twee echte computers. Die is alleen getest met een nagebootste
  tweede browser.
- De PSA-koppeling met een echte PokemonPriceTracker-sleutel.

## 3. Listing

**Naam (uit het manifest):** `Cardmarket Cart Saver`.
*Advies:* noem hem **Cart Saver for Cardmarket**. Een naam die begint met
een merk van een ander kan bij de beoordeling als "lijkt officieel" worden
gezien. "for Cardmarket" is daar de gebruikelijke vorm voor. Laat het weten,
dan pas ik `extName` aan.

**Categorie:** Winkelen (Shopping) · **Talen:** Nederlands, Engels

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
> • Optioneel: geschatte PSA-waarde voor Pokémon-kaarten (met je eigen PokemonPriceTracker-sleutel) en prijzen vergeleken met de trend.
>
> Privacy: alles blijft in je eigen browser en in de sync van je eigen browser-account. Er is geen server en er is geen tracking. Cart Saver praat met cardmarket.com via je eigen sessie, en voegt alleen iets toe aan je mandje als jij erop klikt.
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
> • Optional: estimated PSA value for Pokémon cards (with your own PokemonPriceTracker key) and prices compared with the trend.
>
> Privacy: everything stays in your own browser and your own browser account's sync. No server, no tracking. Cart Saver talks to cardmarket.com through your own session, and only adds to your cart when you click.
>
> Cart Saver is unofficial and not affiliated with Cardmarket.

### Afbeeldingen (`docs/store/`)

| Bestand | Formaat | Inhoud |
|---|---|---|
| `screenshot-01-terugzetten.png` | 1280×800 | Popup met wat terug kan, en de melding op Cardmarket |
| `screenshot-02-per-verkoper.png` | 1280×800 | Paneel op de mandjepagina, per verkoper |
| `screenshot-03-vervanging.png` | 1280×800 | Resultaat met een verkochte kaart, en de vervangingen |
| `screenshot-04-favorieten-lijsten.png` | 1280×800 | Favorieten en bewaarde lijsten |
| `screenshot-05-psa.png` | 1280×800 | Geschatte PSA-waarde |
| `promo-tile-440x280.png` | 440×280 | Kleine promotegel |
| `icons/icon128.png` | 128×128 | Store-icoon |

Op de screenshots staan echte schermen van de extensie, gemaakt tegen de
nagebootste Cardmarket uit de tests. Ze zijn in het Nederlands. Engelse
screenshots kan ik later maken. Controleer de eisen aan de afbeeldingen in
het dashboard zelf, want die veranderen weleens.

### Links

- Privacybeleid: <https://github.com/MilanVeenstra/CartSaver/blob/main/PRIVACY.md>
- Ondersteuning / startpagina: <https://github.com/MilanVeenstra/CartSaver>
  (vragen via Issues)

## 4. Privacy (tabblad Privacypraktijken)

**Enkel doel:** Het Cardmarket-winkelmandje van de gebruiker onthouden en
opgeslagen artikelen er weer in zetten.

**Uitleg per toestemming:**

| Toestemming | Waarom |
|---|---|
| `storage` | Opgeslagen artikelen, favorieten, lijsten en instellingen bewaren, in de browser en via de sync van het eigen browser-account. |
| `unlimitedStorage` | Kleine kopieën van productplaatjes en grote lijsten kunnen boven de standaardlimiet van de lokale opslag komen. |
| `alarms` | Dagelijks opruimen, de optionele prijsgids, een herinnering 5 minuten voordat Cardmarket het mandje leegt, en de optionele controle als je weg bent. |
| `notifications` | Melden dat opgeslagen artikelen uit het mandje vielen terwijl je op een ander tabblad was, en vóórdat Cardmarket het mandje leegt. Uit te zetten. |
| `idle` | De optionele controle "mandje controleren als je niet op Cardmarket kijkt" draait alleen als je achter de computer zit. Staat standaard uit. |
| `declarativeNetRequestWithHostAccess` | Eén regel die bij de eigen verzoeken van de extensie naar de plaatjesserver van Cardmarket de Referer op cardmarket.com zet. De server weigert ze anders. Verzoeken van webpagina's blijven ongemoeid. |
| `https://www.cardmarket.com/*` | Het mandje en productpagina's lezen, en op klik artikelen terugzetten met dezelfde verzoeken als de knoppen van de site. |
| `https://product-images.s3.cardmarket.com/*` | Productplaatjes voor de popup. |
| `https://downloads.s3.cardmarket.com/*` | Optioneel, standaard uit: de openbare prijsgids van Cardmarket. |
| `https://www.pokemonpricetracker.com/*` | Optioneel, standaard uit: geschatte PSA-waardes met de eigen sleutel van de gebruiker. |

**Externe code:** Nee. Alle code zit in het pakket. Er worden alleen
gegevens opgehaald (JSON en HTML-pagina's), nooit code.

**Gegevensgebruik.** Kruis aan wat het dashboard vraagt, naar de feitelijke
situatie:
- *Website-inhoud:* ja. De artikelen in het winkelmandje worden lokaal
  opgeslagen en via de sync van het eigen browser-account gedeeld met de
  eigen browsers van de gebruiker. Bij de optionele PSA-schatting gaan de
  naam en het nummer van een kaart naar PokemonPriceTracker.
- *Inloggegevens:* nee. Er worden geen wachtwoorden of cookies gelezen. De
  verzoeken gebruiken de bestaande sessie van de browser.
- *Persoonlijk identificeerbare informatie:* alleen de Cardmarket-gebruikersnaam,
  lokaal, om accounts niet te verwarren. Die wordt niet naar ons verstuurd.
- Verklaringen: gegevens worden niet verkocht, niet gebruikt voor iets anders
  dan het doel, en niet voor kredietwaardigheid.

## 5. Voor de beoordelaar

> Cart Saver works on www.cardmarket.com and needs a (free) Cardmarket account. 1) Log in on cardmarket.com and put any article in the shopping cart. 2) Open the shopping cart page: the Cart Saver panel (bottom right) says the articles are saved. 3) Remove the article with the site's own button: Cart Saver forgets it (you removed it yourself). Put it back, then let the cart be emptied (or log in elsewhere and empty it): on any Cardmarket page a reminder offers "Put 1 back in your cart". 4) The toolbar popup shows the same list, favourites (☆ on any offer) and saved lists. Optional features are off by default (settings page).

Geef nooit inloggegevens in deze tekst. Vraagt het dashboard om een
testaccount, gebruik dan het beveiligde veld daarvoor.

## 6. Na het indienen

- Een update gaat opnieuw door de beoordeling. Terugdraaien kan alleen met
  een nieuwe, ook weer beoordeelde versie.
- Bij elke release: `manifest.json`-versie ophogen, `npm test`,
  `npm run package`, de digest hier noteren, uploaden.
- Ondersteuning via GitHub Issues.
