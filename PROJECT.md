SlopScroll

- infinite scroller of videos (webm) scraped from https://civitai.com/videos (tiktok like scroller)
- civit.ai authentication mechanism (currenty using "Login with Google"), need to reverse ingeneer cookie sent to server
- current playing video must be looped
- must be implemented in node backend which exposes http port with UI for open in browser
- UI --> backend --> civit.ai --> get video feed --> get first video (first try cache on disk) --> video is cached on disk by backend --> user scrolls  --> next video
- idea is to make a cache-first retrieval system to cache retrieved webm indefinitely on disk and try to load from disk when this particular video is requested to load in scroller, if not - donwload the webm and then show it to user
- to achieve this web site loading mechanism must be reverse engineered
- you need to make a granukar plan of building the system and ask me to help to reverse ingeneer civit.ai if you cant do something yourself