# Vim

Vim keybindings for [fulgurite](https://github.com/fulgurite-plugin): normal, insert, visual and visual-line modes,
counts, operators with motions and text objects, `.` repeat, ex commands and a vimrc.

- Motions `hjkl w b e W B E ge gE 0 ^ $ | + - _ <CR> gg G f t F T ; , % { } H M L` with counts (`3w`, `50%`)
- Scrolling `Ctrl-d Ctrl-u` (a count sets how far, like Vim's `'scroll'`), `Ctrl-f Ctrl-b`, `Ctrl-e Ctrl-y`, `zt zz zb`.
  On Windows Ctrl+F, Ctrl+E and Ctrl+Y stay the app's (find, search, redo)
- Operators `d c y` + a motion or text object (`dw ciw da" di( yip`), `dd cc yy`, `x X D C`, `p P`, `r`, `.`
- `v V` visual, `u` / `Ctrl-r`, `:w :q :wq :<line>`
- `<Space>p` the command palette, `<Space>f` search, `<Space>o` open by title, `<Space>n` new note, `gf` the
  `[[link]]` under the cursor, `/` `n` `N` find in the note
- The register is the system clipboard. Any input source works: with Korean on, normal-mode keys still follow the key
  under your finger.

On iPhone and iPad normal mode takes the software keyboard's letters and the status line has an esc key; Ctrl chords
need a hardware keyboard.

## vimrc

Settings › Plugin Options › Vim › Edit vimrc… (`~/.config/fulgurite/vimrc` on the Mac, Files › fulgurite › vimrc on
iPhone and iPad). Saved changes apply immediately. It takes comments, `let mapleader = " "`,
`nmap` / `nnoremap <keys> :<ex command><CR>` and `nunmap <keys>`. `:<command id>` runs any command in the palette:

```vim
nnoremap <leader>m :fulgurite.math:insert-inline<CR>
nnoremap <leader>b :view.toggleSidebar<CR>
```

## Development

See [api](https://github.com/fulgurite-plugin/fulgurite-api).
