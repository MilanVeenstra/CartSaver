# Privacy — Cart Saver for Cardmarket

*Nederlands hieronder · English below*

Laatst bijgewerkt: 19 oktober 2026 (versie 1.6.5).

## Nederlands

Cart Saver is een browserextensie die onthoudt wat je in je
Cardmarket-winkelmandje legt, zodat je het kunt terugzetten nadat Cardmarket
je mandje heeft geleegd. Cart Saver is onofficieel en niet verbonden aan
Cardmarket.

**Wat Cart Saver bewaart.** De artikelen in je winkelmandje (kaart of
product, verkoper, conditie, taal, prijs, aantal, links en plaatjes),
favorieten die je met een ster bewaart, lijsten die je zelf opslaat, en je
instellingen. Ook de gebruikersnaam van je Cardmarket-account, zodat de
extensie niets door elkaar haalt als iemand anders inlogt.

**Waar.** In je eigen browser (`chrome.storage`). Staat *Synchroniseren via
je browser-account* aan (standaard aan, uit te zetten in de instellingen),
dan gaan je favorieten, lijsten, opgeslagen artikelen en instellingen ook
via de sync van je eigen browser naar je andere browsers. In Chrome is dat
je Google-account. Die sync is van jou en van je browser. Wij hebben er geen
toegang toe en draaien geen eigen server.

**Met wie Cart Saver praat.**
- **cardmarket.com**, via je eigen ingelogde sessie. Cart Saver leest daar je
  winkelmandje en productpagina's. Alleen als jij erom vraagt, voegt hij
  artikelen toe aan je mandje of haalt hij ze eruit, met dezelfde verzoeken
  als de knoppen op de site. Wachtwoorden worden nooit gelezen of bewaard.
- **De plaatjesserver van Cardmarket** (product-images.s3.cardmarket.com),
  voor de plaatjes in de popup.
- **Alleen als je het aanzet:** de openbare prijsgids van Cardmarket
  (downloads.s3.cardmarket.com), één keer per dag, om prijzen met de trend te
  vergelijken. Er gaat niets van jou heen.
- **Alleen als je het aanzet:** PokemonPriceTracker
  (www.pokemonpricetracker.com), voor geschatte PSA-waardes van
  Pokémon-kaarten. Dan gaan de naam en het nummer van de kaart daarheen, met
  de API-sleutel die je zelf invult. Hun eigen privacybeleid geldt daar.

**Wat Cart Saver niet doet.** Geen analytics, geen tracking, geen
advertenties. Er wordt niets verkocht of gedeeld met anderen. Er wordt niets
gelezen buiten cardmarket.com.

**Hoe lang.** Tot jij het weghaalt. Verkochte en genegeerde artikelen gaan
na een maand vanzelf uit de lijst. *Alles verwijderen* in de instellingen
wist alles, met synchroniseren aan ook in je andere browsers. Verwijder je
de extensie, dan wist je browser de lokale gegevens.

**Contact.** Vragen of problemen: maak een issue aan op
<https://github.com/MilanVeenstra/CartSaver/issues>.

## English

Cart Saver is a browser extension that remembers what you put in your
Cardmarket shopping cart, so you can put it back after Cardmarket emptied the
cart. Cart Saver is unofficial and not affiliated with Cardmarket.

**What Cart Saver keeps.** The articles in your shopping cart (card or
product, seller, condition, language, price, quantity, links and pictures),
favourites you star, lists you save yourself, and your settings. Also the
username of your Cardmarket account, so nothing gets mixed up when someone
else logs in.

**Where.** In your own browser (`chrome.storage`). With *Sync through your
browser account* on (on by default, can be switched off in the settings),
your favourites, lists, saved articles and settings also travel through your
own browser's sync to your other browsers. In Chrome that is your Google
account. That sync belongs to you and your browser. We have no access to it
and run no server of our own.

**Who Cart Saver talks to.**
- **cardmarket.com**, through your own logged-in session. Cart Saver reads
  your shopping cart and product pages there. Only when you ask, it adds
  articles to your cart or takes them out, with the same requests as the
  site's own buttons. Passwords are never read or stored.
- **Cardmarket's picture server** (product-images.s3.cardmarket.com), for
  the pictures in the popup.
- **Only if you switch it on:** Cardmarket's public price guide
  (downloads.s3.cardmarket.com), once a day, to compare prices with the trend.
  Nothing of yours is sent there.
- **Only if you switch it on:** PokemonPriceTracker
  (www.pokemonpricetracker.com), for estimated PSA values of Pokémon cards.
  The card's name and number are sent there, with the API key you enter
  yourself. Their own privacy policy applies there.

**What Cart Saver does not do.** No analytics, no tracking, no ads. Nothing
is sold or shared with anyone. Nothing is read outside cardmarket.com.

**How long.** Until you remove it. Sold and ignored articles leave the list
by themselves after a month. *Delete everything* in the settings removes
everything, with sync on also in your other browsers. When you remove the
extension, your browser deletes its local data.

**Contact.** Questions or problems: open an issue at
<https://github.com/MilanVeenstra/CartSaver/issues>.
