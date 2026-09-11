# Mémoire, outils et injection d’instructions

Un agent peut recevoir du texte non fiable depuis une API, un jeton, une description de contrat ou une mémoire antérieure. Ce texte est une donnée, même lorsqu’il ressemble à une consigne destinée au modèle.

Les résultats d’outils devraient être structurés et séparés des instructions système. Les champs libres doivent être bornés, étiquetés par leur origine et exclus des décisions d’autorisation.

La mémoire persistante amplifie le risque : une donnée malveillante peut influencer plusieurs sessions après la disparition de sa source. Il faut donc prévoir portée, expiration, suppression et provenance pour chaque souvenir.

Aucune sortie du modèle ne doit élargir les capacités disponibles. Les outils autorisés et leurs paramètres sensibles restent contrôlés par du code déterministe et une validation explicite.

[Chapitre suivant : moindre privilège](07-moindre-privilege.md)
