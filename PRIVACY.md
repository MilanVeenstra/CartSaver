# Privacy — Cart Saver for Cardmarket

*Nederlands hieronder · English below*

Laatst bijgewerkt: 21 oktober 2026 (versie 1.6.7).

## Nederlands

Cart Saver is een browserextensie die onthoudt wat je in je
Cardmarket-winkelmandje legt, zodat je het kunt terugzetten nadat Cardmarket
je mandje heeft geleegd. Cart Saver is onofficieel en niet verbonden aan
Cardmarket. Er is geen server van ons: niets van jou komt bij ons terecht.

**Wat Cart Saver bewaart.**
- De artikelen in je winkelmandje: kaart of product, verkoper, conditie, taal,
  prijs, aantal, links en plaatjes, de beschrijving die de verkoper bij het
  artikel zette, en de prijzen die het artikel eerder had (met de datum).
- Favorieten die je met een ster bewaart, en lijsten die je zelf opslaat.
- Je instellingen, waaronder de taal.
- De gebruikersnaam van je Cardmarket-account, zodat de extensie niets door
  elkaar haalt als iemand anders inlogt.
- Alleen als je de PSA-schatting aanzet: de API-sleutel van
  PokemonPriceTracker die je zelf invult, en de prijzen die daarbij horen.

**Waar.** In je eigen browser (`chrome.storage`). Staat *Synchroniseren via
je browser-account* aan (standaard aan, uit te zetten in de instellingen),
dan gaan je favorieten, lijsten, opgeslagen artikelen en instellingen ook via
de sync van je eigen browser naar je andere browsers. In Chrome is dat je
Google-account. Je API-sleutel, plaatjes, prijsgeschiedenis en prijzen uit de
prijsgids gaan niet mee: die blijven in elke browser apart. Die sync is van jou en van je browser. Wij hebben er
geen toegang toe.

**Wat Cart Saver op cardmarket.com doet.** Alles via je eigen ingelogde
sessie, in je eigen browser:
- Hij leest je winkelmandje, productpagina's en aanbiedingen van verkopers
  (voor prijzen, favorieten en vervangingen). Op een bestelpagina kijkt hij
  welke artikelen je kocht, zodat die uit de lijst gaan.
- Om te herkennen dat je zelf iets uit je mandje haalt, kijkt hij naar de
  eigen verzoeken van de site en naar klikken op de knoppen van het mandje.
  Uit die verzoeken leest hij ook de beveiligingscode (CSRF-token) van je
  sessie. Die heeft hij nodig om artikelen terug te zetten op dezelfde
  manier als de knoppen van de site. Staat die code nergens, dan opent hij
  op de achtergrond een paar Cardmarket-pagina's (het mandje, je
  verlanglijst, de startpagina) en leest daar alleen de code uit. De code
  blijft in het geheugen van de pagina en wordt nooit opgeslagen of ergens
  heen gestuurd. Verzoeken naar andere websites laat hij met rust.
- Alleen als jij erom vraagt, zet hij artikelen in je mandje of haalt hij ze
  eruit. Wachtwoorden worden nooit gelezen of bewaard.

**Met wie Cart Saver nog meer praat.**
- **De plaatjesserver van Cardmarket** (product-images.s3.cardmarket.com),
  voor de plaatjes in de popup.
- **Alleen als je het aanzet:** de openbare prijsgids van Cardmarket
  (downloads.s3.cardmarket.com), één keer per dag, om prijzen met de trend te
  vergelijken. Er gaat niets van jou heen. Chrome vraagt je eerst om
  toestemming voor die website.
- **Alleen als je het aanzet:** PokemonPriceTracker
  (www.pokemonpricetracker.com), voor geschatte PSA-waardes van
  Pokémon-kaarten. Dan gaan de naam en het nummer van de kaart daarheen, met
  de API-sleutel die je zelf invult. Chrome vraagt je eerst om toestemming
  voor die website. Hun eigen privacybeleid geldt daar.

**Wat Cart Saver niet doet.** Geen analytics, geen tracking, geen
advertenties. Er wordt niets verkocht of gedeeld met anderen, en niets
gebruikt voor iets anders dan wat hierboven staat. Er wordt niets gelezen
buiten cardmarket.com.

Het gebruik van informatie door Cart Saver volgt het
[gebruikersgegevensbeleid van de Chrome Web Store](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
inclusief de eisen voor beperkt gebruik (Limited Use).

**Hoe lang.** Tot jij het weghaalt. Verkochte en genegeerde artikelen gaan na
een maand vanzelf uit de lijst. *Alles wissen* in de instellingen wist alles
wat Cart Saver bewaart: artikelen, favorieten, lijsten, je gebruikersnaam, je
API-sleutel, plaatjes, prijzen en instellingen (alleen de taal en de
sync-schakelaar blijven staan), ook uit de sync van je browser-account.
Verwijder je de extensie, dan wist je browser de lokale gegevens.

**Contact.** Vragen of problemen: maak een issue aan op
<https://github.com/MilanVeenstra/CartSaver/issues>.

## English

Cart Saver is a browser extension that remembers what you put in your
Cardmarket shopping cart, so you can put it back after Cardmarket emptied the
cart. Cart Saver is unofficial and not affiliated with Cardmarket. There is no
server of ours: nothing of yours ever reaches us.

**What Cart Saver keeps.**
- The articles in your shopping cart: card or product, seller, condition,
  language, price, quantity, links and pictures, the description the seller
  wrote for the article, and the prices it had before (with the date).
- Favourites you star, and lists you save yourself.
- Your settings, including the language.
- The username of your Cardmarket account, so nothing gets mixed up when
  someone else logs in.
- Only if you switch on the PSA estimate: the PokemonPriceTracker API key you
  enter yourself, and the prices that come with it.

**Where.** In your own browser (`chrome.storage`). With *Sync through your
browser account* on (on by default, can be switched off in the settings),
your favourites, lists, saved articles and settings also travel through your
own browser's sync to your other browsers. In Chrome that is your Google
account. Your API key, pictures, price history and price-guide prices do not
travel: they stay separate in every browser. That sync belongs to you and your browser. We have no access
to it.

**What Cart Saver does on cardmarket.com.** All through your own logged-in
session, in your own browser:
- It reads your shopping cart, product pages and sellers' offers (for prices,
  favourites and replacements). On an order page it looks at which articles
  you bought, so they leave the list.
- To recognise that you removed something from your cart yourself, it looks
  at the site's own requests and at clicks on the cart's buttons. From those
  requests it also reads your session's security code (CSRF token). It needs
  that code to put articles back the same way the site's buttons do. When the
  code is nowhere to be found, it opens a few Cardmarket pages in the
  background (the cart, your wants list, the home page) and reads only the
  code from them. The code stays in the page's memory and is never stored or
  sent anywhere. Requests to other websites are left alone.
- Only when you ask, it adds articles to your cart or takes them out.
  Passwords are never read or stored.

**Who else Cart Saver talks to.**
- **Cardmarket's picture server** (product-images.s3.cardmarket.com), for
  the pictures in the popup.
- **Only if you switch it on:** Cardmarket's public price guide
  (downloads.s3.cardmarket.com), once a day, to compare prices with the trend.
  Nothing of yours is sent there. Chrome asks you for permission for that
  website first.
- **Only if you switch it on:** PokemonPriceTracker
  (www.pokemonpricetracker.com), for estimated PSA values of Pokémon cards.
  The card's name and number are sent there, with the API key you enter
  yourself. Chrome asks you for permission for that website first. Their own
  privacy policy applies there.

**What Cart Saver does not do.** No analytics, no tracking, no ads. Nothing
is sold or shared with anyone, and nothing is used for anything other than
what is described above. Nothing is read outside cardmarket.com.

Cart Saver's use of information adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

**How long.** Until you remove it. Sold and ignored articles leave the list
by themselves after a month. *Delete everything* in the settings deletes
everything Cart Saver keeps: articles, favourites, lists, your username, your
API key, pictures, prices and settings (only the language and the sync switch
stay), also from your browser account's sync. When you remove the extension,
your browser deletes its local data.

**Contact.** Questions or problems: open an issue at
<https://github.com/MilanVeenstra/CartSaver/issues>.
