# General

- Filenames use camel case:
  - if the file is a component, it should be named after the component, so `ChatMessage.ts` for a `ChatMessage` component.
  - if the file is a utility, it should be named after the utility, so `createChatMessage.ts` for a `createChatMessage` function.

# UI Components

- Components are built using GTK4 and libadwaita, and are styled using CSS.
- Components should be one main component per file, in the `src/ui` directory.
- If you need to do styling, read the docs:
  - https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/css-variables.html
