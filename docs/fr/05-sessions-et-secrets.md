# Sessions, chiffrement et rotation des secrets

Le projet décrit des sessions signées par HMAC et des valeurs sensibles chiffrées au repos avec AES-256-GCM, avec dérivation de clé par HKDF. Ces mécanismes protègent des risques différents et ne doivent pas partager leurs usages.

Une clé de session authentifie un état de connexion ; une clé de chiffrement protège des données stockées. Réutiliser un même secret pour les deux augmente le rayon d’impact d’une fuite ou d’une rotation.

La rotation de SESSION_SECRET invalide les sessions et peut rendre des lignes chiffrées illisibles. Cette conséquence doit être traitée comme une migration opérationnelle : version de clé, période de transition et procédure de récupération explicite.

Les journaux ne doivent contenir ni jetons, ni charges déchiffrées, ni URL enrichies de secrets. Les erreurs devraient exposer un identifiant de corrélation plutôt que la donnée fautive.

[Chapitre suivant : mémoire et injection](06-memoire-et-injection.md)
