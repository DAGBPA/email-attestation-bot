#!/bin/sh
sed -ie "s/version = '1.0'/version = '1.0t'/; s/alt = '1'/alt = '2'/" node_modules/dag-pizza-dough/constants.js
sed -ie "s/.hub = 'dagpizza.org\/pp'/.hub = 'dagpizza.org\/pp-test'/" conf.js
